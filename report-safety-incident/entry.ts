/**
 * Report a safety incident.
 *
 * Anyone connected to a ride can report — the rider, the assigned driver, a
 * scheduler, or staff. Reporting immediately opens a retention hold so the
 * record cannot be deleted or administratively closed while it is being looked
 * at, and freezes the ride if it is still live.
 *
 * This function never assesses severity of danger, never contacts emergency
 * services, and never tells anyone not to call 911.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { hasRole, isRideParty, viewerKindFor } from "../../shared/authz.ts";
import { canTransition } from "../../shared/state-machine.ts";
import type { RideState } from "../../shared/constants.ts";
import { idempotencyKey } from "../../shared/ids.ts";
import { renderTemplate } from "../../shared/notifications.ts";

const TYPES = [
  "crash", "injury", "harassment", "discrimination", "suspected_abuse_neglect",
  "missing_rider", "vehicle_issue", "inappropriate_conduct", "failed_handoff", "other",
];

/** Types that always reach safety staff at urgent priority, whatever severity was picked. */
const ALWAYS_URGENT = ["crash", "injury", "suspected_abuse_neglect", "missing_rider", "failed_handoff"];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const incidentType = String(body.incident_type ?? "");
    if (!TYPES.includes(incidentType)) return fail("invalid_type", "Choose what kind of concern this is.", 400);

    const narrative = String(body.narrative ?? "").trim();
    if (narrative.length < 10) {
      return fail("narrative_required", "Tell us briefly what happened, in your own words.", 400);
    }

    const rideId = body.ride_request_id ? String(body.ride_request_id) : "";
    let ride: Record<string, string> | null = null;

    if (rideId) {
      const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
      ride = (rides ?? [])[0] ?? null;
      if (!ride) return notFound("That ride does not exist.");

      const assignments = await ctx.base44.asServiceRole.entities.RideAssignment.filter({
        ride_request_id: rideId, is_active: true,
      });
      const assignment = (assignments ?? [])[0];
      const isAssignedDriver = Boolean(assignment) && assignment.driver_user_id === ctx.principal.userId;
      const viewer = viewerKindFor(ctx.principal, ride, isAssignedDriver);
      if (viewer === "public") {
        await audit(ctx, {
          event_type: "incident.report", action: "create", outcome: "denied",
          subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_ride_party",
        });
        return notFound("That ride does not exist.");
      }
    }

    const now = new Date().toISOString();
    const config = await loadConfig(ctx);
    const severity = ALWAYS_URGENT.includes(incidentType)
      ? "critical"
      : String(body.severity ?? "moderate");

    const incident = await ctx.base44.asServiceRole.entities.SafetyIncident.create({
      ride_request_id: rideId || undefined,
      reported_by_user_id: ctx.principal.userId,
      reporter_role: ctx.principal.roles.join(",") || "rider",
      incident_type: incidentType,
      severity,
      occurred_at: body.occurred_at ? String(body.occurred_at) : now,
      narrative,
      immediate_actions_taken: body.immediate_actions_taken ? String(body.immediate_actions_taken) : "",
      emergency_services_contacted: body.emergency_services_contacted === true,
      status: "open",
      source: body.source ? String(body.source) : "reported_by_person",
    });

    // The hold goes on before anything else can touch the record.
    const hold = await ctx.base44.asServiceRole.entities.DataRetentionHold.create({
      hold_key: `incident-${incident.id}`,
      scope_entity: "RideRequest",
      scope_id: rideId || undefined,
      reason: incidentType === "suspected_abuse_neglect" ? "safeguarding" : "incident",
      opened_by_email: ctx.principal.email,
      opened_at: now,
      is_active: true,
      notes: `Opened automatically by incident ${incident.id}.`,
    });
    await ctx.base44.asServiceRole.entities.SafetyIncident.update(incident.id, { retention_hold_id: hold.id });

    // Freeze the ride if the state machine allows it from where it is.
    let rideFrozen = false;
    if (ride) {
      const gate = canTransition(ride.status as RideState, "incident_hold", {
        actorRole: "safety_staff", reasonCode: `incident_${incidentType}`,
      });
      if (gate.allowed) {
        await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, {
          status: "incident_hold",
          status_reason_code: `incident_${incidentType}`,
          retention_hold_active: true,
        });
        await ctx.base44.asServiceRole.entities.RideEvent.create({
          ride_request_id: rideId, event_type: "escalation",
          from_state: ride.status, to_state: "incident_hold",
          actor_user_id: ctx.principal.userId, actor_role: "reporter",
          reason_code: `incident_${incidentType}`, occurred_at: now,
        });
        rideFrozen = true;
      } else {
        await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, { retention_hold_active: true });
      }
    }

    // Alert safety staff. The alert carries no narrative and no location.
    const staff = await ctx.base44.asServiceRole.entities.RoleAssignment.filter({
      role: "safety_staff", status: "approved",
    });
    const rendered = renderTemplate("incident_update", {
      brandName: String(config.brand_name),
      genericDestinationLabel: "a recent ride",
      supportPhone: String(config.safety_phone || ""),
    });
    for (const member of staff ?? []) {
      await ctx.base44.asServiceRole.entities.Notification.create({
        recipient_user_id: member.user_id,
        recipient_email: member.user_email,
        channel: "in_app",
        template_key: "incident_update",
        subject: rendered.subject,
        body: rendered.body,
        ride_request_id: rideId || undefined,
        idempotency_key: idempotencyKey(["incident_update", incident.id, member.user_id]),
        status: "queued",
        queued_at: now,
      });
    }

    await audit(ctx, {
      event_type: "incident.report", action: "create",
      subject_entity: "SafetyIncident", subject_id: incident.id,
      reason_code: incidentType,
      metadata: { severity, ride_frozen: rideFrozen, hold_id: hold.id, staff_alerted: (staff ?? []).length },
    });

    return ok({
      incident_id: incident.id,
      severity,
      ride_frozen: rideFrozen,
      retention_hold_id: hold.id,
      emergency_note: "If anyone is in danger or hurt, call 911 now. This report does not contact emergency services.",
      safety_phone: config.safety_phone || null,
      message: "Reported. Our safety team has been alerted and this record is now locked from deletion.",
    }, 201);
  } catch (e) {
    console.error("report_safety_incident_failed", String(e));
    return serverError();
  }
}
