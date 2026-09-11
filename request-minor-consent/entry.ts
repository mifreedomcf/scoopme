/**
 * Put a child's ride into awaiting_consent and ask the verified guardian to sign.
 *
 * A ride created by a coordinator, a referring adult, or an organization sits
 * here until the guardian themselves signs. No driver can see it, claim it, or
 * be assigned to it in the meantime — the state machine has no edge from
 * awaiting_consent to offered.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { idempotencyKey } from "../../shared/ids.ts";
import { renderTemplate } from "../../shared/notifications.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const config = await loadConfig(ctx);
    if (!config.minor_rides_enabled) {
      return fail("minor_rides_disabled", "Rides for under-18s are switched off.", 409);
    }
    if (!hasRole(ctx.principal, "dispatcher") && !hasRole(ctx.principal, "platform_admin") && !hasRole(ctx.principal, "guardian")) {
      return forbidden("Only a coordinator or the child's guardian can start this.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");
    const scope = body.scope === "standing" ? "standing" : "single_ride";

    const sr = ctx.base44.asServiceRole.entities;
    const rides = await sr.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");
    if (ride.rider_kind !== "minor" || !ride.dependent_profile_id) {
      return fail("not_a_minor_ride", "That ride is not for a child.", 400);
    }

    // Standing consent stays unavailable until counsel has approved its wording.
    if (scope === "standing" && !config.standing_minor_consent_approved) {
      return fail(
        "standing_consent_not_approved",
        "Standing consent is not available. Its wording has not been approved by counsel, so each trip needs its own signature.",
        409,
      );
    }

    const relRows = await sr.GuardianRelationship.filter({
      dependent_profile_id: ride.dependent_profile_id, status: "verified",
    }, "-verified_at", 5);
    const relationship = (relRows ?? [])[0];
    if (!relationship) {
      return fail(
        "no_verified_guardian",
        "No verified parent or legal guardian is recorded for this child. A coordinator has to verify that first.",
        409,
      );
    }

    const docs = await sr.LegalDocument.filter(
      { document_key: "guardian_agreement_minor_authorization", published: true }, "-effective_at", 1,
    );
    const document = (docs ?? [])[0];
    if (!document) {
      return fail("consent_document_missing", "The guardian consent wording has not been published yet.", 409);
    }

    const now = new Date().toISOString();

    // Supersede any earlier open request for this child and trip.
    const existing = await sr.ConsentRecord.filter({
      dependent_profile_id: ride.dependent_profile_id, ride_request_id: rideId, status: "requested",
    }, "-created_date", 10);
    for (const c of existing ?? []) {
      await sr.ConsentRecord.update(c.id, { status: "superseded" });
    }

    const record = await sr.ConsentRecord.create({
      dependent_profile_id: ride.dependent_profile_id,
      ride_request_id: scope === "single_ride" ? rideId : undefined,
      guardian_relationship_id: relationship.id,
      scope,
      status: "requested",
      legal_document_id: document.id,
      document_key: document.document_key,
      document_version: document.version,
      consent_text_snapshot: document.body_markdown,
    });

    if (ride.status !== "awaiting_consent") {
      await sr.RideRequest.update(rideId, { status: "awaiting_consent", status_reason_code: "guardian_consent_required" });
      await sr.RideEvent.create({
        ride_request_id: rideId, event_type: "transition",
        from_state: ride.status, to_state: "awaiting_consent",
        actor_user_id: ctx.principal.userId, actor_role: "dispatcher",
        reason_code: "guardian_consent_required", occurred_at: now,
      });
    }

    const rendered = renderTemplate("consent_needed", {
      brandName: String(config.brand_name),
      genericDestinationLabel: "a scheduled ride",
    });
    await sr.Notification.create({
      recipient_user_id: relationship.guardian_user_id,
      recipient_email: relationship.guardian_email,
      channel: "in_app",
      template_key: "consent_needed",
      subject: rendered.subject,
      body: rendered.body,
      ride_request_id: rideId,
      idempotency_key: idempotencyKey(["consent_needed", record.id, relationship.guardian_user_id]),
      status: "queued",
      queued_at: now,
    });

    await audit(ctx, {
      event_type: "minor.consent_requested", action: "create",
      subject_entity: "ConsentRecord", subject_id: record.id,
      metadata: { ride_request_id: rideId, scope, document_version: document.version },
    });

    return ok({
      consent_record_id: record.id,
      ride_status: "awaiting_consent",
      document_version: document.version,
      message:
        "The guardian has been asked to sign. Nothing is offered to a driver, and no driver can see this ride, until they do.",
    }, 201);
  } catch (e) {
    console.error("request_minor_consent_failed", String(e));
    return serverError();
  }
}
