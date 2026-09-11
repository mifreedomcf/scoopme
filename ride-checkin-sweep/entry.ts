/**
 * Check-in timers for rides that are underway.
 *
 * These alerts assist people. Nothing here cancels a ride, contacts emergency
 * services, or decides that something is or is not an emergency — it raises a
 * flag on the dispatcher board and, at urgent level, opens an incident for a
 * safety staff member to read.
 */
import { ok, serverError } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { escalationAudience, evaluateRideWatch, type EscalationLevel } from "../../shared/escalation.ts";
import { idempotencyKey } from "../../shared/ids.ts";
import { renderTemplate } from "../../shared/notifications.ts";

const WATCHED = [
  "confirmed", "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff",
];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    const sr = ctx.base44.asServiceRole.entities;
    const now = new Date();
    const config = await loadConfig(ctx);

    const summary = { rides_watched: 0, alerts_raised: 0, incidents_opened: 0 };

    const rides = await sr.RideRequest.filter({ status: { $in: WATCHED } }, "requested_pickup_at", 500);

    for (const ride of rides ?? []) {
      summary.rides_watched += 1;

      const assignments = await sr.RideAssignment.filter({ ride_request_id: ride.id, is_active: true });
      const assignment = (assignments ?? [])[0];
      if (!assignment) continue;

      const verdict = evaluateRideWatch({
        status: ride.status,
        requested_pickup_at: ride.requested_pickup_at,
        arrival_by_at: ride.arrival_by_at,
        last_check_in_at: assignment.last_check_in_at,
        escalation_level: (assignment.escalation_level ?? 0) as EscalationLevel,
        now,
      });
      if (!verdict.raise || !verdict.kind) continue;

      summary.alerts_raised += 1;
      const nowIso = now.toISOString();

      await sr.RideAssignment.update(assignment.id, {
        escalation_level: verdict.level,
        escalation_kind: verdict.kind,
        escalation_last_at: nowIso,
      });
      await sr.RideEvent.create({
        ride_request_id: ride.id,
        event_type: "escalation",
        actor_role: "system",
        reason_code: verdict.kind,
        note: `${verdict.message} ${verdict.minutesLate} minutes past the threshold.`,
        occurred_at: nowIso,
      });

      // Notify the right audience. The alert carries no address and no code.
      const rendered = renderTemplate("incident_update", {
        brandName: String(config.brand_name),
        genericDestinationLabel: "a ride in progress",
        supportPhone: String(config.safety_phone || ""),
      });
      for (const role of escalationAudience(verdict.level)) {
        const staff = await sr.RoleAssignment.filter({ role, status: "approved" });
        for (const member of staff ?? []) {
          await sr.Notification.create({
            recipient_user_id: member.user_id,
            recipient_email: member.user_email,
            channel: "in_app",
            template_key: "incident_update",
            subject: rendered.subject,
            body: `${verdict.message} Open the dispatch board.`,
            ride_request_id: ride.id,
            idempotency_key: idempotencyKey(["escalation", ride.id, verdict.kind, verdict.level, member.user_id]),
            status: "queued",
            queued_at: nowIso,
          });
        }
      }

      // At urgent level, open an incident so a person owns it. The timer states
      // what it observed; it does not classify what happened.
      if (verdict.level >= 2) {
        const existing = await sr.SafetyIncident.filter({
          ride_request_id: ride.id, source: "escalation_timer", status: "open",
        }, undefined, 1);
        if ((existing ?? []).length === 0) {
          const incident = await sr.SafetyIncident.create({
            ride_request_id: ride.id,
            reported_by_user_id: "system",
            reporter_role: "system",
            incident_type: "other",
            severity: "high",
            occurred_at: nowIso,
            narrative: `Automatic check-in timer. Observed: ${verdict.message} Ride was in state ${ride.status}, ${verdict.minutesLate} minutes past the threshold. No assessment of what happened has been made — a person needs to look at this.`,
            status: "open",
            source: "escalation_timer",
            escalation_kind: verdict.kind,
          });
          const hold = await sr.DataRetentionHold.create({
            hold_key: `escalation-${incident.id}`,
            scope_entity: "RideRequest",
            scope_id: ride.id,
            reason: "incident",
            opened_by_email: "system",
            opened_at: nowIso,
            is_active: true,
            notes: `Opened by the check-in timer: ${verdict.kind}.`,
          });
          await sr.SafetyIncident.update(incident.id, { retention_hold_id: hold.id });
          await sr.RideRequest.update(ride.id, { retention_hold_active: true });
          summary.incidents_opened += 1;
        }
      }

      await audit(ctx, {
        event_type: "sweep.ride_escalation", action: "update",
        subject_entity: "RideRequest", subject_id: ride.id,
        reason_code: verdict.kind,
        metadata: { level: verdict.level, minutes_late: verdict.minutesLate },
      });
    }

    return ok({ ...summary, checked_at: now.toISOString() });
  } catch (e) {
    console.error("ride_checkin_sweep_failed", String(e));
    return serverError();
  }
}
