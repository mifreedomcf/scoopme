/**
 * The only path by which RideRequest.status changes.
 *
 * RLS denies client updates to RideRequest entirely, so a caller cannot skip
 * this function and write a state directly.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, hasActiveHold, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { canTransition, ActorRole } from "../../shared/state-machine.ts";
import type { RideState } from "../../shared/constants.ts";
import { hasRole, isRideParty } from "../../shared/authz.ts";
import { canFulfillRides } from "../../shared/flags.ts";
import { verificationCode } from "../../shared/ids.ts";
import { evaluateMinorRide } from "../../shared/minor-runtime.ts";

/** States that mean a ride is actually being driven. Gated on fulfillment. */
const OPERATIONAL_STATES: RideState[] = [
  "offered", "claimed", "confirmed", "en_route", "arrived_pickup",
  "rider_verified", "in_progress", "arrived_dropoff", "handoff_verified", "completed",
];

function actorRoleFor(principal: ReturnType<typeof Object>, isAssignedDriver: boolean): ActorRole {
  const p = principal as { roles: string[]; platformRole: string };
  if (p.platformRole === "admin" || p.roles.includes("platform_admin")) return "platform_admin";
  if (p.roles.includes("safety_staff")) return "safety_staff";
  if (p.roles.includes("dispatcher")) return "dispatcher";
  if (isAssignedDriver) return "driver";
  if (p.roles.includes("guardian")) return "guardian";
  if (p.roles.includes("org_scheduler") || p.roles.includes("org_admin")) return "org_scheduler";
  return "rider";
}

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const rideId = String(body.ride_request_id ?? "");
    const to = String(body.to_state ?? "") as RideState;
    const reasonCode = body.reason_code ? String(body.reason_code) : undefined;
    if (!rideId || !to) return fail("missing_fields", "ride_request_id and to_state are required.", 400);

    const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    const assignments = await ctx.base44.asServiceRole.entities.RideAssignment.filter({
      ride_request_id: rideId,
      is_active: true,
    });
    const activeAssignment = (assignments ?? [])[0] ?? null;
    const isAssignedDriver =
      Boolean(activeAssignment) && activeAssignment.driver_user_id === ctx.principal.userId;

    const actorRole = actorRoleFor(ctx.principal, isAssignedDriver);
    const rideParty = isRideParty(ctx.principal, ride);

    // A person with no relationship to the ride and no staff role gets a 404,
    // not a 403 — we do not confirm that someone else's ride exists.
    if (!rideParty && !isAssignedDriver && !hasRole(ctx.principal, "dispatcher") &&
        !hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      await audit(ctx, {
        event_type: "ride.transition", action: "transition", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_authorized",
      });
      return notFound("That ride does not exist.");
    }

    const holdActive = await hasActiveHold(ctx, "RideRequest", rideId);

    const verdict = canTransition(ride.status as RideState, to, {
      actorRole,
      reasonCode,
      isAssignedDriver,
      isRideParty: rideParty,
      retentionHoldActive: holdActive,
    });
    if (!verdict.allowed) {
      await audit(ctx, {
        event_type: "ride.transition", action: "transition", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId,
        from_state: ride.status, to_state: to, reason_code: verdict.code,
      });
      return fail(verdict.code, verdict.message, verdict.code === "actor_not_permitted" ? 403 : 409);
    }

    // Operational states additionally require fulfillment to be permitted right
    // now — not merely at the time the flag was set.
    if (OPERATIONAL_STATES.includes(to)) {
      const config = await loadConfig(ctx);
      const gates = await loadGates(ctx);

      // A child's ride is re-checked against every requirement on EVERY move,
      // not once at approval. Consent withdrawn an hour ago stops the ride
      // here, even if it was legitimately offered this morning.
      if (ride.rider_kind === "minor") {
        const minorVerdict = await evaluateMinorRide(ctx, ride, config, gates, todayISO());
        if (!minorVerdict.allowed) {
          await audit(ctx, {
            event_type: "minor.gate_blocked", action: "transition", outcome: "denied",
            subject_entity: "RideRequest", subject_id: rideId,
            from_state: ride.status, to_state: to,
            reason_code: minorVerdict.blocking[0]?.code ?? "minor_gate_blocked",
            metadata: { blocking: minorVerdict.blocking.map((b) => b.code).join(",") },
          });
          return fail(
            "minor_ride_blocked",
            minorVerdict.blocking.map((b) => b.message).join(" "),
            409,
            minorVerdict.blocking.map((b) => ({ field: "minor_requirements", code: b.code, message: b.message })),
          );
        }
      }

      const fulfillment = canFulfillRides(config, gates, todayISO());
      if (!fulfillment.allowed) {
        await audit(ctx, {
          event_type: "ride.transition", action: "transition", outcome: "denied",
          subject_entity: "RideRequest", subject_id: rideId, from_state: ride.status,
          to_state: to, reason_code: fulfillment.code,
        });
        return fail(fulfillment.code, fulfillment.message, 409);
      }
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: to, status_reason_code: reasonCode };
    if (to === "approved") patch.approved_at = now;
    if (to === "completed") {
      patch.completed_at = now;
      // Volunteer minutes are measured from the moment the driver set off, so
      // waiting time counts. Read from the immutable timeline, not the clock.
      const events = await ctx.base44.asServiceRole.entities.RideEvent.filter(
        { ride_request_id: rideId, to_state: "en_route" }, "occurred_at", 1,
      );
      const departed = (events ?? [])[0]?.occurred_at;
      if (departed) {
        patch.volunteer_minutes = Math.max(
          0,
          Math.round((new Date(now).getTime() - new Date(departed).getTime()) / 60_000),
        );
      }
    }
    if (["canceled", "driver_canceled", "closed_by_admin"].includes(to)) patch.canceled_at = now;
    if (to === "incident_hold") patch.retention_hold_active = true;

    // The verification code is rotated whenever a ride is confirmed. A code is
    // never reused, including across reassignment of the same ride.
    if (to === "confirmed") {
      patch.verification_code = verificationCode(6);
      patch.verification_code_issued_at = now;
    }
    // Once the ride is over, stop carrying a live code.
    if (["completed", "canceled", "driver_canceled", "closed_by_admin"].includes(to)) {
      patch.verification_code = "";
    }

    await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, patch);

    // Any deliberate move by a person counts as a check-in, which resets the
    // silence timer. An escalation is cleared only by a person acting on the
    // ride, never by the timer deciding things look fine again.
    if (activeAssignment) {
      const assignmentPatch: Record<string, unknown> = { last_check_in_at: now };
      if (activeAssignment.escalation_level && actorRole !== "system") {
        assignmentPatch.escalation_level = 0;
        assignmentPatch.escalation_kind = "";
      }
      if (["driver_canceled", "canceled", "closed_by_admin", "completed"].includes(to)) {
        assignmentPatch.is_active = false;
        assignmentPatch.released_at = now;
        assignmentPatch.release_reason_code = reasonCode ?? to;
      }
      await ctx.base44.asServiceRole.entities.RideAssignment.update(activeAssignment.id, assignmentPatch);
    }

    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: rideId,
      event_type: "transition",
      from_state: ride.status,
      to_state: to,
      actor_user_id: ctx.principal.userId,
      actor_role: actorRole,
      reason_code: reasonCode,
      occurred_at: now,
    });

    await audit(ctx, {
      event_type: "ride.transition", action: "transition",
      subject_entity: "RideRequest", subject_id: rideId,
      from_state: ride.status, to_state: to, reason_code: reasonCode,
    });

    return ok({ ride_request_id: rideId, status: to, message: verdict.message });
  } catch (e) {
    console.error("transition_ride_failed", String(e));
    return serverError();
  }
}
