/**
 * A reviewer verifies or rejects one credential, then eligibility is recomputed.
 *
 * The reviewer cannot be the driver, and a document that has not been scanned
 * clean cannot be verified.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { computeEligibility, EXPIRY_NOTICE_DAYS } from "../../shared/eligibility.ts";
import { mayServeAttachment } from "../../shared/uploads.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only safety staff can verify credentials.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const credentialId = String(body.credential_id ?? "");
    const decision = String(body.decision ?? "");
    const reasonCategory = body.decision_reason_category ? String(body.decision_reason_category) : "";

    if (!["verify", "reject"].includes(decision)) {
      return fail("invalid_decision", "decision must be verify or reject.", 400);
    }

    const rows = await ctx.base44.asServiceRole.entities.DriverCredential.filter({ id: credentialId }, undefined, 1);
    const credential = (rows ?? [])[0];
    if (!credential) return notFound("That credential does not exist.");

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter(
      { id: credential.driver_profile_id }, undefined, 1,
    );
    const profile = (profiles ?? [])[0];
    if (!profile) return notFound("That driver profile does not exist.");

    if (profile.user_id === ctx.principal.userId) {
      await audit(ctx, {
        event_type: "credential.review", action: "approve", outcome: "denied",
        subject_entity: "DriverCredential", subject_id: credentialId, reason_code: "self_review_blocked",
      });
      return forbidden("You cannot verify your own credentials.");
    }

    const today = todayISO();
    const now = new Date().toISOString();

    if (decision === "verify") {
      if (credential.document_reference && !mayServeAttachment(credential.document_scan_status ?? "pending")) {
        return fail(
          "document_not_scanned",
          "This document has not been scanned clean yet, so it cannot be verified. Configure the malware scanner first.",
          409,
        );
      }
      if (!credential.expiration_date) {
        return fail("expiration_required", "Record the expiry date before verifying.", 400);
      }
      if (credential.expiration_date < today) {
        return fail("already_expired", "That document expired. Ask for a current one.", 409);
      }
    }

    await ctx.base44.asServiceRole.entities.DriverCredential.update(credentialId, {
      status: decision === "verify" ? "verified" : "rejected",
      decision_reason_category: reasonCategory,
      verified_by_email: ctx.principal.email,
      verified_at: now,
      vendor_name: body.vendor_name ? String(body.vendor_name) : credential.vendor_name,
      vendor_reference_id: body.vendor_reference_id ? String(body.vendor_reference_id) : credential.vendor_reference_id,
    });

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
      eligibility_computed_at: now,
    });

    await audit(ctx, {
      event_type: "credential.review", action: decision === "verify" ? "approve" : "reject",
      subject_entity: "DriverCredential", subject_id: credentialId,
      reason_code: reasonCategory || decision,
      metadata: {
        credential_type: credential.credential_type,
        driver_profile_id: profile.id,
        resulting_eligibility: eligibility.status,
      },
    });

    return ok({
      credential_id: credentialId,
      status: decision === "verify" ? "verified" : "rejected",
      driver_eligibility: eligibility.status,
      still_blocking: eligibility.blocking,
      expiring_within_days: EXPIRY_NOTICE_DAYS,
      expiring_soon: eligibility.expiring_soon,
    });
  } catch (e) {
    console.error("review_driver_credential_failed", String(e));
    return serverError();
  }
}
