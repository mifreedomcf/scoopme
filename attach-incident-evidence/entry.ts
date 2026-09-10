/**
 * Attach evidence to an incident as a private storage reference.
 *
 * The file is recorded as pending and is not served to anyone until a scanner
 * has returned clean. With no scanner configured, that means it is never
 * served — which is the correct behaviour, not a bug.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { scanStatusFor, unavailableScanner, validateUpload } from "../../shared/uploads.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const incidentId = String(body.incident_id ?? "");
    const fileReference = String(body.file_reference ?? "");

    const rows = await ctx.base44.asServiceRole.entities.SafetyIncident.filter({ id: incidentId }, undefined, 1);
    const incident = (rows ?? [])[0];
    if (!incident) return notFound("That incident does not exist.");

    // The reporter can add to their own report; otherwise safety staff only.
    const isReporter = incident.reported_by_user_id === ctx.principal.userId;
    if (!isReporter && !hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return notFound("That incident does not exist.");
    }

    if (!fileReference) return fail("missing_fields", "file_reference is required.", 400);
    if (/^https?:\/\//i.test(fileReference)) {
      return fail("public_url_rejected", "Evidence must be a private upload, not a link.", 400);
    }

    const verdict = validateUpload({
      filename: String(body.filename ?? ""),
      contentType: String(body.content_type ?? ""),
      sizeBytes: Number(body.size_bytes ?? 0),
      purpose: "incident_evidence",
    });
    if (!verdict.ok) return fail(verdict.code, verdict.message, 400);

    // Milestone 7 swaps in a live scanner. Until then this returns "unavailable".
    const scan = await unavailableScanner.scan(fileReference);
    const scanStatus = scanStatusFor(scan.verdict);

    const now = new Date().toISOString();
    const attachment = await ctx.base44.asServiceRole.entities.IncidentAttachment.create({
      incident_id: incidentId,
      file_reference: fileReference,
      content_type: String(body.content_type),
      size_bytes: Number(body.size_bytes),
      scan_status: scanStatus,
      uploaded_by_email: ctx.principal.email,
      uploaded_at: now,
    });

    await audit(ctx, {
      event_type: "incident.attach", action: "create",
      subject_entity: "IncidentAttachment", subject_id: attachment.id,
      metadata: { incident_id: incidentId, scan_status: scanStatus, scanner: unavailableScanner.name },
    });

    return ok({
      attachment_id: attachment.id,
      scan_status: scanStatus,
      viewable: scanStatus === "clean",
      message: scanStatus === "clean"
        ? "Attached."
        : "Attached and stored. It stays locked until a malware scanner is configured and has checked it.",
    }, 201);
  } catch (e) {
    console.error("attach_incident_evidence_failed", String(e));
    return serverError();
  }
}
