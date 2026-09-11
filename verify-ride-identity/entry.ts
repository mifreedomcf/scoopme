/**
 * Pickup identity verification.
 *
 * The rider is shown a rotating code and says it to the driver. The driver
 * types it here. The code itself is never sent to the driver's device, so it
 * cannot be read off a screen or a notification — it has to be spoken by the
 * person who has it.
 *
 * Attempts are rate-limited and every attempt, right or wrong, is audited.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { safeEqual } from "../../shared/ids.ts";
import { canTransition } from "../../shared/state-machine.ts";
import type { RideState } from "../../shared/constants.ts";

const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");
    const submitted = String(body.verification_code ?? "").trim().toUpperCase();
    if (!rideId || !submitted) return fail("missing_fields", "ride_request_id and verification_code are required.", 400);

    const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    const assignments = await ctx.base44.asServiceRole.entities.RideAssignment.filter({
      ride_request_id: rideId, is_active: true,
    });
    const assignment = (assignments ?? [])[0];
    if (!assignment || assignment.driver_user_id !== ctx.principal.userId) {
      await audit(ctx, {
        event_type: "ride.identity_verify", action: "read", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_assigned_driver",
      });
      return notFound("That ride does not exist.");
    }

    const gate = canTransition(ride.status as RideState, "rider_verified", {
      actorRole: "driver", isAssignedDriver: true,
    });
    if (!gate.allowed) return fail(gate.code, gate.message, 409);

    // Rate limit code guessing, per ride.
    const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString();
    const events = await ctx.base44.asServiceRole.entities.RideEvent.filter(
      { ride_request_id: rideId, event_type: "check_in" }, "-occurred_at", 50,
    );
    const recentFailures = (events ?? []).filter(
      (e: { reason_code?: string; occurred_at: string }) =>
        e.reason_code === "identity_code_mismatch" && e.occurred_at >= since,
    ).length;
    if (recentFailures >= MAX_ATTEMPTS) {
      await audit(ctx, {
        event_type: "ride.identity_verify", action: "read", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "too_many_attempts",
      });
      return fail(
        "too_many_attempts",
        "Too many wrong codes. Call the safety line and do not start the ride.",
        429,
      );
    }

    const now = new Date().toISOString();
    const expected = String(ride.verification_code ?? "");

    if (!expected || !safeEqual(expected, submitted)) {
      await ctx.base44.asServiceRole.entities.RideEvent.create({
        ride_request_id: rideId, event_type: "check_in",
        actor_user_id: ctx.principal.userId, actor_role: "driver",
        reason_code: "identity_code_mismatch", occurred_at: now,
      });
      await audit(ctx, {
        event_type: "ride.identity_verify", action: "read", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "identity_code_mismatch",
        metadata: { attempts_in_window: recentFailures + 1 },
      });
      // The response never hints at the real code or its shape.
      return fail(
        "code_mismatch",
        `That code does not match. ${MAX_ATTEMPTS - recentFailures - 1} tries left. If it keeps failing, do not start the ride — call the safety line.`,
        403,
      );
    }

    await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, {
      status: "rider_verified", status_reason_code: "identity_verified",
    });
    await ctx.base44.asServiceRole.entities.RideAssignment.update(assignment.id, { last_check_in_at: now });
    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: rideId, event_type: "transition",
      from_state: ride.status, to_state: "rider_verified",
      actor_user_id: ctx.principal.userId, actor_role: "driver",
      reason_code: "identity_verified", occurred_at: now,
    });
    await audit(ctx, {
      event_type: "ride.identity_verify", action: "transition",
      subject_entity: "RideRequest", subject_id: rideId,
      from_state: ride.status, to_state: "rider_verified",
    });

    return ok({
      ride_request_id: rideId,
      status: "rider_verified",
      message: "Verified. You can start the ride.",
    });
  } catch (e) {
    console.error("verify_ride_identity_failed", String(e));
    return serverError();
  }
}
