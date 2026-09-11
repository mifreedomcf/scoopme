/**
 * Safety staff work an incident. Releasing the retention hold is a separate,
 * platform-admin-only act, so closing an incident never quietly unlocks the
 * record for deletion.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

const EDITABLE = ["status", "assigned_to_email", "severity", "immediate_actions_taken", "mandated_report_filed", "emergency_services_contacted"];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only safety staff can work incidents.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const incidentId = String(body.incident_id ?? "");

    const rows = await ctx.base44.asServiceRole.entities.SafetyIncident.filter({ id: incidentId }, undefined, 1);
    const incident = (rows ?? [])[0];
    if (!incident) return notFound("That incident does not exist.");

    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.changes ?? {})) {
      if (EDITABLE.includes(k)) patch[k] = v;
    }
    if (patch.status === "resolved" || patch.status === "closed") {
      if (!incident.immediate_actions_taken && !patch.immediate_actions_taken) {
        return fail("actions_required", "Record what was done before closing this.", 400);
      }
      patch.resolved_at = new Date().toISOString();
    }
    // A suspected abuse or neglect report cannot be closed until the mandated
    // report has been recorded as filed.
    if (
      (patch.status === "resolved" || patch.status === "closed") &&
      incident.incident_type === "suspected_abuse_neglect" &&
      !(patch.mandated_report_filed ?? incident.mandated_report_filed)
    ) {
      return fail(
        "mandated_report_required",
        "Record the mandated report to the state authority before closing this.",
        409,
      );
    }

    if (Object.keys(patch).length > 0) {
      await ctx.base44.asServiceRole.entities.SafetyIncident.update(incidentId, patch);
    }

    // Releasing the hold: platform admin only, typed justification required.
    let holdReleased = false;
    if (body.release_hold === true) {
      if (!hasRole(ctx.principal, "platform_admin")) {
        return forbidden("Only a platform administrator can release a retention hold.");
      }
      const justification = String(body.release_justification ?? "");
      if (justification.trim().length < 40) {
        return fail("justification_required", "Explain in writing why this hold can be released. At least 40 characters.", 400);
      }
      if (!["resolved", "closed"].includes(String(patch.status ?? incident.status))) {
        return fail("incident_not_closed", "Close the incident before releasing its hold.", 409);
      }
      if (incident.retention_hold_id) {
        await ctx.base44.asServiceRole.entities.DataRetentionHold.update(incident.retention_hold_id, {
          is_active: false,
          released_by_email: ctx.principal.email,
          released_at: new Date().toISOString(),
          notes: justification,
        });
        if (incident.ride_request_id) {
          await ctx.base44.asServiceRole.entities.RideRequest.update(incident.ride_request_id, {
            retention_hold_active: false,
          });
        }
        holdReleased = true;
        await audit(ctx, {
          event_type: "hold.release", action: "override",
          subject_entity: "DataRetentionHold", subject_id: incident.retention_hold_id,
          justification, reason_code: "incident_closed",
        });
      }
    }

    await audit(ctx, {
      event_type: "incident.update", action: "update",
      subject_entity: "SafetyIncident", subject_id: incidentId,
      from_state: incident.status, to_state: String(patch.status ?? incident.status),
      metadata: { fields: Object.keys(patch).join(","), hold_released: holdReleased },
    });

    return ok({
      incident_id: incidentId,
      status: patch.status ?? incident.status,
      hold_released: holdReleased,
    });
  } catch (e) {
    console.error("manage_safety_incident_failed", String(e));
    return serverError();
  }
}
