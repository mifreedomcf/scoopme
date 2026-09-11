/**
 * A driver confirms who is handing over or collecting a child.
 *
 * The driver never receives the PIN. The adult reads it out and the driver
 * types it. Every failure path ends the same way: stop, stay with the child,
 * call the safety line. The driver is never asked to judge whether someone
 * seems fine, and is never offered an alternative destination.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import {
  FAILED_HANDOFF_INSTRUCTIONS, MAX_HANDOFF_ATTEMPTS, verifyHandoff,
  type AuthorizedAdult,
} from "../../shared/handoff.ts";
import { idempotencyKey } from "../../shared/ids.ts";
import { canTransition } from "../../shared/state-machine.ts";
import type { RideState } from "../../shared/constants.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const config = await loadConfig(ctx);
    if (!config.minor_rides_enabled) {
      return fail("minor_rides_disabled", "Rides for under-18s are switched off.", 409);
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");
    const role = String(body.role ?? "") === "pickup" ? "pickup" : "dropoff";

    const sr = ctx.base44.asServiceRole.entities;
    const rides = await sr.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    const assignments = await sr.RideAssignment.filter({ ride_request_id: rideId, is_active: true });
    const assignment = (assignments ?? [])[0];
    if (!assignment || assignment.driver_user_id !== ctx.principal.userId) {
      await audit(ctx, {
        event_type: "minor.handoff_attempt", action: "read", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_assigned_driver",
      });
      return notFound("That ride does not exist.");
    }

    const handoffs = await sr.HandoffRecord.filter({ ride_request_id: rideId, role }, "-pin_issued_at", 1);
    const handoff = (handoffs ?? [])[0];
    if (!handoff) return fail("no_handoff_record", "No handoff has been set up for this leg. Call the safety line.", 409);

    const adults = ((await sr.AuthorizedAdult.filter({ dependent_profile_id: handoff.dependent_profile_id })) ?? [])
      .map((a: Record<string, unknown>) => ({
        id: String(a.id), dependent_profile_id: String(a.dependent_profile_id),
        name: String(a.name), relationship: String(a.relationship), phone: String(a.phone),
        role: String(a.role), active: a.active !== false,
      })) as AuthorizedAdult[];

    const now = new Date().toISOString();
    const outcome = verifyHandoff(
      {
        dependent_profile_id: handoff.dependent_profile_id,
        ride_request_id: rideId,
        role,
        claimed_adult_id: String(body.authorized_adult_id ?? ""),
        submitted_pin: String(body.pin ?? ""),
        now,
      },
      {
        expected_pin: handoff.pin,
        expected_adult_ids: handoff.expected_adult_ids ?? [],
        pin_issued_at: handoff.pin_issued_at,
        pin_used_at: handoff.pin_used_at,
        failed_attempts: Number(handoff.failed_attempts ?? 0),
      },
      adults,
    );

    if (!outcome.ok) {
      const attempts = Number(handoff.failed_attempts ?? 0) + 1;
      await sr.HandoffRecord.update(handoff.id, {
        failed_attempts: attempts,
        failure_reason_code: outcome.code,
        outcome: attempts >= MAX_HANDOFF_ATTEMPTS || outcome.escalate ? "failed" : "pending",
      });
      await sr.RideEvent.create({
        ride_request_id: rideId, event_type: "check_in",
        actor_user_id: ctx.principal.userId, actor_role: "driver",
        reason_code: `handoff_${outcome.code}`, occurred_at: now,
      });
      await audit(ctx, {
        event_type: "minor.handoff_attempt", action: "read", outcome: "denied",
        subject_entity: "HandoffRecord", subject_id: handoff.id,
        reason_code: outcome.code, metadata: { attempts, role },
      });

      // A real failure freezes the ride and puts a person on it. The driver is
      // told to stop, not to work something out.
      if (outcome.escalate) {
        const gate = canTransition(ride.status as RideState, "failed_handoff", {
          actorRole: "driver", isAssignedDriver: true, reasonCode: outcome.code,
        });
        if (gate.allowed) {
          await sr.RideRequest.update(rideId, {
            status: "failed_handoff", status_reason_code: outcome.code, retention_hold_active: true,
          });
          await sr.RideEvent.create({
            ride_request_id: rideId, event_type: "escalation",
            from_state: ride.status, to_state: "failed_handoff",
            actor_user_id: ctx.principal.userId, actor_role: "driver",
            reason_code: outcome.code, occurred_at: now,
          });
        }
        const incident = await sr.SafetyIncident.create({
          ride_request_id: rideId,
          reported_by_user_id: ctx.principal.userId,
          reporter_role: "driver",
          incident_type: "failed_handoff",
          severity: "critical",
          occurred_at: now,
          narrative: `Handoff could not be completed at ${role}. Reason recorded by the system: ${outcome.code}. The driver was instructed to stop, stay with the child, and call the safety line. No assessment of what happened has been made.`,
          status: "open",
          source: "failed_handoff",
        });
        const hold = await sr.DataRetentionHold.create({
          hold_key: `handoff-${incident.id}`,
          scope_entity: "RideRequest", scope_id: rideId,
          reason: "safeguarding", opened_by_email: "system", opened_at: now, is_active: true,
          notes: `Failed handoff: ${outcome.code}.`,
        });
        await sr.SafetyIncident.update(incident.id, { retention_hold_id: hold.id });
        await sr.HandoffRecord.update(handoff.id, { safety_incident_id: incident.id, outcome: "failed" });

        for (const role2 of ["safety_staff", "dispatcher"]) {
          const staff = await sr.RoleAssignment.filter({ role: role2, status: "approved" });
          for (const member of staff ?? []) {
            await sr.Notification.create({
              recipient_user_id: member.user_id,
              recipient_email: member.user_email,
              channel: "in_app",
              template_key: "failed_handoff",
              subject: `${config.brand_name}: a drop-off could not be completed`,
              body: "A handoff could not be completed and the driver has been told to stop and call. Open the safety centre now.",
              ride_request_id: rideId,
              idempotency_key: idempotencyKey(["failed_handoff", incident.id, member.user_id]),
              status: "queued",
              queued_at: now,
            });
          }
        }

        return fail(outcome.code, outcome.message, 409, [
          { field: "pin", code: outcome.code, message: outcome.message },
          ...FAILED_HANDOFF_INSTRUCTIONS.map((instruction, i) => ({
            field: `instruction_${i + 1}`, code: "do_this_now", message: instruction,
          })),
        ]);
      }

      return fail(outcome.code, outcome.message, 403);
    }

    // Verified.
    await sr.HandoffRecord.update(handoff.id, {
      pin_used_at: now,
      verified_adult_id: String(body.authorized_adult_id),
      verified_at: now,
      outcome: "verified",
    });
    await sr.RideAssignment.update(assignment.id, { last_check_in_at: now });

    const target: RideState = role === "pickup" ? "rider_verified" : "handoff_verified";
    const gate = canTransition(ride.status as RideState, target, { actorRole: "driver", isAssignedDriver: true });
    if (gate.allowed) {
      await sr.RideRequest.update(rideId, { status: target, status_reason_code: `handoff_verified_${role}` });
      await sr.RideEvent.create({
        ride_request_id: rideId, event_type: "transition",
        from_state: ride.status, to_state: target,
        actor_user_id: ctx.principal.userId, actor_role: "driver",
        reason_code: `handoff_verified_${role}`, occurred_at: now,
      });
    }

    await audit(ctx, {
      event_type: "minor.handoff_verified", action: "transition",
      subject_entity: "HandoffRecord", subject_id: handoff.id,
      to_state: target, metadata: { role, adult_id: String(body.authorized_adult_id) },
    });

    return ok({
      ride_request_id: rideId,
      role,
      status: gate.allowed ? target : ride.status,
      message: outcome.message,
      reminder: "Never leave a child on their own, and never hand them to someone who is not on the list.",
    });
  } catch (e) {
    console.error("verify_minor_handoff_failed", String(e));
    return serverError();
  }
}
