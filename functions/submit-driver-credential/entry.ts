/**
 * A driver submits or replaces one credential document.
 *
 * The driver supplies a private storage reference and the dates. They can never
 * set `status: verified` — only `review-driver-credential` does that, and only
 * a reviewer can call it. Uploading a new document resets an existing
 * credential back to `submitted` and recomputes eligibility, so replacing a
 * document does not silently keep a stale verification.
 */
import { fail, forbidden, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { validateUpload } from "../../shared/uploads.ts";
import { computeEligibility } from "../../shared/eligibility.ts";

const DRIVER_SUBMITTABLE = [
  "drivers_license", "vehicle_registration", "auto_insurance", "insurer_volunteer_acknowledgement",
  "vehicle_inspection", "cpr", "first_aid", "cdl", "wheelchair_lift_inspection",
  "securement_training", "car_seat_availability", "language_certification", "other",
];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const credentialType = String(body.credential_type ?? "");
    if (!DRIVER_SUBMITTABLE.includes(credentialType)) {
      // Background checks, fingerprinting, and registry screening come from a
      // vendor, never from the person being screened.
      return forbidden("That check cannot be submitted by the driver. It comes from the screening vendor.");
    }

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter(
      { user_id: ctx.principal.userId }, undefined, 1,
    );
    const profile = (profiles ?? [])[0];
    if (!profile) return forbidden("Start a driver application first.");

    const upload = body.upload as { filename?: string; content_type?: string; size_bytes?: number } | undefined;
    const fileReference = body.document_reference ? String(body.document_reference) : "";
    let scanStatus = "not_applicable";

    if (fileReference) {
      if (/^https?:\/\//i.test(fileReference)) {
        return fail("public_url_rejected", "Credential documents must be uploaded as private files, not links.", 400);
      }
      const verdict = validateUpload({
        filename: String(upload?.filename ?? ""),
        contentType: String(upload?.content_type ?? ""),
        sizeBytes: Number(upload?.size_bytes ?? 0),
        purpose: "driver_credential",
      });
      if (!verdict.ok) return fail(verdict.code, verdict.message, 400);
      // No scanner is configured yet, so the document stays pending and is not
      // shown to a reviewer. Pending is not clean.
      scanStatus = "pending";
    }

    const expiration = body.expiration_date ? String(body.expiration_date) : "";
    const today = todayISO();
    if (expiration && expiration < today) {
      return fail("already_expired", "That document has already expired. Upload a current one.", 400);
    }

    const existing = await ctx.base44.asServiceRole.entities.DriverCredential.filter({
      driver_profile_id: profile.id, credential_type: credentialType,
    }, undefined, 1);

    const patch = {
      driver_profile_id: profile.id,
      credential_type: credentialType,
      required_for: body.required_for ? String(body.required_for) : "adult_transport",
      status: "submitted",
      completed_date: body.completed_date ? String(body.completed_date) : undefined,
      expiration_date: expiration || undefined,
      document_reference: fileReference || undefined,
      document_content_type: upload?.content_type,
      document_size_bytes: upload?.size_bytes,
      document_scan_status: scanStatus,
      // Any prior verification is cleared: a new document is unverified.
      verified_by_email: "",
      verified_at: "",
    };

    let credentialId: string;
    if ((existing ?? []).length > 0) {
      credentialId = existing[0].id;
      await ctx.base44.asServiceRole.entities.DriverCredential.update(credentialId, patch);
    } else {
      const created = await ctx.base44.asServiceRole.entities.DriverCredential.create(patch);
      credentialId = created.id;
    }

    // Replacing a document can drop the driver out of eligibility immediately.
    const config = await loadConfig(ctx);
    const [credentials, vehicles] = await Promise.all([
      ctx.base44.asServiceRole.entities.DriverCredential.filter({ driver_profile_id: profile.id }),
      ctx.base44.asServiceRole.entities.Vehicle.filter({ driver_profile_id: profile.id }),
    ]);
    const eligibility = computeEligibility({
      approval_tier: profile.approval_tier,
      admin_suspended: profile.admin_suspended,
      on_incident_hold: profile.on_incident_hold,
      credentials: credentials ?? [],
      vehicles: vehicles ?? [],
      today,
    });
    await ctx.base44.asServiceRole.entities.DriverProfile.update(profile.id, {
      eligibility_status: eligibility.status,
      eligibility_reason_code: eligibility.reason_code,
      eligibility_blocking: eligibility.blocking,
      eligibility_computed_at: new Date().toISOString(),
    });

    await audit(ctx, {
      event_type: "credential.submit", action: "update",
      subject_entity: "DriverCredential", subject_id: credentialId,
      metadata: { credential_type: credentialType, has_document: Boolean(fileReference), scan: scanStatus },
    });

    return ok({
      credential_id: credentialId,
      status: "submitted",
      document_scan_status: scanStatus,
      eligibility_status: eligibility.status,
      message: fileReference
        ? "Uploaded. A coordinator reviews it once the file has been scanned."
        : "Saved. Upload the document when you have it.",
    }, (existing ?? []).length > 0 ? 200 : 201);
  } catch (e) {
    console.error("submit_driver_credential_failed", String(e));
    return serverError();
  }
}
