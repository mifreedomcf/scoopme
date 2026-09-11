/**
 * Staff verify that an adult really is a child's parent or legal guardian.
 *
 * This is always a human act against a document. Nobody self-verifies, an
 * organization cannot be verified as a guardian, and an unscanned document
 * cannot be accepted.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { mayServeAttachment } from "../../shared/uploads.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only safety staff can verify guardian authority.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const relationshipId = String(body.guardian_relationship_id ?? "");
    const decision = String(body.decision ?? "");
    if (!["verify", "reject", "revoke"].includes(decision)) {
      return fail("invalid_decision", "decision must be verify, reject, or revoke.", 400);
    }

    const sr = ctx.base44.asServiceRole.entities;
    const rows = await sr.GuardianRelationship.filter({ id: relationshipId }, undefined, 1);
    const relationship = (rows ?? [])[0];
    if (!relationship) return notFound("That record does not exist.");

    if (relationship.guardian_user_id === ctx.principal.userId) {
      await audit(ctx, {
        event_type: "minor.authority_review", action: "approve", outcome: "denied",
        subject_entity: "GuardianRelationship", subject_id: relationshipId,
        reason_code: "self_verification_blocked",
      });
      return forbidden("You cannot verify your own guardian authority.");
    }

    const today = todayISO();
    const now = new Date().toISOString();

    if (decision === "verify") {
      if (!relationship.document_reference) {
        return fail(
          "document_required",
          "Verification needs a document on file. A stated relationship on its own is not proof of legal authority.",
          400,
        );
      }
      if (!mayServeAttachment(relationship.document_scan_status ?? "pending")) {
        return fail(
          "document_not_scanned",
          "That document has not been scanned clean, so it cannot be opened or accepted yet.",
          409,
        );
      }
      const expiresOn = String(body.expires_on ?? "");
      if (!expiresOn) {
        return fail("expiry_required", "Set a re-verification date. Authority is never open-ended here.", 400);
      }
      if (expiresOn <= today) {
        return fail("expiry_in_past", "That re-verification date has already passed.", 400);
      }

      await sr.GuardianRelationship.update(relationshipId, {
        status: "verified",
        verified_by_email: ctx.principal.email,
        verified_at: now,
        expires_on: expiresOn,
        rejected_reason_category: "",
      });
      await audit(ctx, {
        event_type: "minor.authority_review", action: "approve",
        subject_entity: "GuardianRelationship", subject_id: relationshipId,
        to_state: "verified",
        metadata: { authority_type: relationship.authority_type, expires_on: expiresOn },
      });
      return ok({
        guardian_relationship_id: relationshipId,
        status: "verified",
        expires_on: expiresOn,
        note: "Verified authority is not consent. Each trip still needs a signature on the current wording.",
      });
    }

    const target = decision === "reject" ? "rejected" : "revoked";
    await sr.GuardianRelationship.update(relationshipId, {
      status: target,
      rejected_reason_category: String(body.reason_category ?? ""),
      revoked_at: decision === "revoke" ? now : undefined,
    });

    // Anything relying on this authority stops relying on it immediately.
    const consents = await sr.ConsentRecord.filter({
      dependent_profile_id: relationship.dependent_profile_id, status: "signed",
    }, "-created_date", 200);
    for (const c of consents ?? []) {
      if (c.guardian_relationship_id === relationshipId) {
        await sr.ConsentRecord.update(c.id, { status: "revoked", revoked_at: now, revoked_by_user_id: "system" });
      }
    }

    await audit(ctx, {
      event_type: "minor.authority_review", action: "reject",
      subject_entity: "GuardianRelationship", subject_id: relationshipId,
      to_state: target, reason_code: String(body.reason_category ?? decision),
      metadata: { consents_revoked: (consents ?? []).length },
    });

    return ok({
      guardian_relationship_id: relationshipId,
      status: target,
      consents_revoked: (consents ?? []).length,
    });
  } catch (e) {
    console.error("verify_guardian_authority_failed", String(e));
    return serverError();
  }
}
