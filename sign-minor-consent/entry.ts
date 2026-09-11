/**
 * A verified guardian signs consent for a child's trip.
 *
 * The only caller who can succeed here is the person whose verified authority
 * covers this child. A coordinator cannot sign on their behalf, an organization
 * scheduler cannot, and neither can a teacher, doctor or case manager who
 * arranged the trip. That refusal is not a permission check bolted on top — it
 * is the entire purpose of `canSignForMinor`.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { canSignForMinor, checkAuthority, validateAttestation, type GuardianAuthority } from "../../shared/consent.ts";

function truncateIp(ip: string): string {
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : "";
}

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
    const consentId = String(body.consent_record_id ?? "");

    const sr = ctx.base44.asServiceRole.entities;
    const rows = await sr.ConsentRecord.filter({ id: consentId }, undefined, 1);
    const record = (rows ?? [])[0];
    if (!record) return notFound("That consent request does not exist.");
    if (record.status !== "requested") {
      return fail("not_awaiting_signature", "That consent request is no longer open.", 409);
    }

    const today = todayISO();
    const relRows = await sr.GuardianRelationship.filter({ id: record.guardian_relationship_id }, undefined, 1);
    const authority = ((relRows ?? [])[0] ?? null) as GuardianAuthority | null;
    const authorityCheck = checkAuthority(authority, record.dependent_profile_id, ctx.principal.userId, today);

    // Work out what kind of person is asking, then ask the one function that
    // decides who may sign for a child.
    const kind = hasRole(ctx.principal, "org_scheduler") || hasRole(ctx.principal, "org_admin")
      ? "org_scheduler"
      : hasRole(ctx.principal, "dispatcher") || hasRole(ctx.principal, "platform_admin")
        ? "dispatcher"
        : hasRole(ctx.principal, "guardian")
          ? "guardian"
          : "referring_adult";

    const eligibility = canSignForMinor(kind, authorityCheck);
    if (!eligibility.canSign) {
      await audit(ctx, {
        event_type: "minor.consent_signature", action: "create", outcome: "denied",
        subject_entity: "ConsentRecord", subject_id: consentId,
        reason_code: eligibility.code, metadata: { requester_kind: kind },
      });
      return forbidden(eligibility.message);
    }

    // The version currently published is what has to be signed.
    const docs = await sr.LegalDocument.filter(
      { document_key: "guardian_agreement_minor_authorization", published: true }, "-effective_at", 1,
    );
    const current = (docs ?? [])[0];
    if (!current || current.version !== record.document_version) {
      await sr.ConsentRecord.update(consentId, { status: "superseded" });
      return fail(
        "consent_version_superseded",
        "The wording has changed since this was sent. Read the current version and sign that one.",
        409,
      );
    }

    if (body.acknowledged !== true) {
      return fail("acknowledgement_required", "Confirm you have read the wording before signing.", 400);
    }

    const now = new Date().toISOString();
    const attestation = {
      document_key: record.document_key,
      document_version: record.document_version,
      signer_user_id: ctx.principal.userId,
      signer_relationship: String(body.signer_relationship ?? authority?.authority_type ?? ""),
      signed_at: now,
      dependent_profile_id: record.dependent_profile_id,
      ride_request_id: record.ride_request_id,
      scope: record.scope,
      expires_on: body.expires_on ? String(body.expires_on) : undefined,
    };
    const validation = validateAttestation(attestation, Boolean(config.standing_minor_consent_approved));
    if (!validation.ok) {
      return fail("validation_failed", "Something is missing from this signature.", 400, validation.errors);
    }

    const forwardedFor = req.headers.get("x-forwarded-for") ?? "";
    await sr.ConsentRecord.update(consentId, {
      status: "signed",
      signer_user_id: ctx.principal.userId,
      signer_email: ctx.principal.email,
      signer_relationship: attestation.signer_relationship,
      signed_at: now,
      request_ip: truncateIp(forwardedFor.split(",")[0].trim()),
      user_agent: req.headers.get("user-agent") ?? "",
      emergency_authorization_given: body.emergency_authorization_given === true,
      starts_on: body.starts_on ? String(body.starts_on) : today,
      expires_on: attestation.expires_on,
    });

    await audit(ctx, {
      event_type: "minor.consent_signed", action: "approve",
      subject_entity: "ConsentRecord", subject_id: consentId,
      metadata: {
        dependent_profile_id: record.dependent_profile_id,
        ride_request_id: record.ride_request_id ?? "",
        scope: record.scope,
        document_version: record.document_version,
        emergency_authorization: body.emergency_authorization_given === true,
      },
    });

    return ok({
      consent_record_id: consentId,
      status: "signed",
      document_version: record.document_version,
      scope: record.scope,
      message:
        "Signed. A coordinator still has to approve the trip and find a driver who is approved to carry children and has the right car seat in the car.",
      withdraw_note: "You can withdraw this at any time before the trip starts.",
    });
  } catch (e) {
    console.error("sign_minor_consent_failed", String(e));
    return serverError();
  }
}
