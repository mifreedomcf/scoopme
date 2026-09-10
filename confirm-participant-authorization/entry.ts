/**
 * A participant confirms, declines, or withdraws an organization's permission
 * to request rides for them.
 *
 * Only the participant can call this for their own record. There is no staff
 * override and no organization path: if the person has not pressed the button,
 * the authorization does not exist.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { idempotencyKey } from "../../shared/ids.ts";

const AUTHORIZATION_TTL_DAYS = 365;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const authorizationId = String(body.authorization_id ?? "");
    const decision = String(body.decision ?? "");
    if (!["confirm", "decline", "withdraw"].includes(decision)) {
      return fail("invalid_decision", "decision must be confirm, decline, or withdraw.", 400);
    }

    const sr = ctx.base44.asServiceRole.entities;
    const rows = await sr.OrganizationParticipantAuthorization.filter({ id: authorizationId }, undefined, 1);
    const authorization = (rows ?? [])[0];
    if (!authorization) return notFound("That request does not exist.");

    // The only person who may act here is the participant themselves.
    if (authorization.participant_user_id !== ctx.principal.userId) {
      await audit(ctx, {
        event_type: "participant_authorization.decide", action: "update", outcome: "denied",
        subject_entity: "OrganizationParticipantAuthorization", subject_id: authorizationId,
        reason_code: "not_the_participant",
      });
      return notFound("That request does not exist.");
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const config = await loadConfig(ctx);
    const orgs = await sr.Organization.filter({ id: authorization.organization_id }, undefined, 1);
    const org = (orgs ?? [])[0];

    if (decision === "confirm") {
      if (authorization.status !== "pending") {
        return fail("not_pending", "That request is no longer waiting on you.", 409);
      }
      if (authorization.expires_at && authorization.expires_at < nowIso) {
        await sr.OrganizationParticipantAuthorization.update(authorizationId, { status: "expired" });
        return fail("request_expired", "That request has expired. Ask them to send a new one.", 409);
      }
      const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_DAYS * 86_400_000).toISOString();
      await sr.OrganizationParticipantAuthorization.update(authorizationId, {
        status: "active",
        verified_by_email: ctx.principal.email,
        verified_at: nowIso,
        expires_at: expiresAt,
      });
      await audit(ctx, {
        event_type: "participant_authorization.decide", action: "approve",
        subject_entity: "OrganizationParticipantAuthorization", subject_id: authorizationId,
        from_state: "pending", to_state: "active",
        metadata: { organization_id: authorization.organization_id, expires_at: expiresAt },
      });
      return ok({
        authorization_id: authorizationId,
        status: "active",
        expires_at: expiresAt,
        message: `${org?.name ?? "That organization"} can now request rides for you. You can withdraw this at any time, and doing so will not affect your own rides.`,
      });
    }

    const target = decision === "decline" ? "revoked" : "revoked";
    await sr.OrganizationParticipantAuthorization.update(authorizationId, {
      status: target,
      revoked_at: nowIso,
    });

    // Rides the organization already has in flight for this person are not
    // silently cancelled — a coordinator is told so the rider is not stranded.
    const openStates = ["eligibility_review", "awaiting_consent", "approved", "offered", "claimed", "confirmed"];
    const inFlight = await sr.RideRequest.filter({
      organization_id: authorization.organization_id,
      rider_user_id: ctx.principal.userId,
      status: { $in: openStates },
    }, "-created_date", 50);

    if ((inFlight ?? []).length > 0) {
      const dispatchers = await sr.RoleAssignment.filter({ role: "dispatcher", status: "approved" });
      for (const d of dispatchers ?? []) {
        await sr.Notification.create({
          recipient_user_id: d.user_id,
          recipient_email: d.user_email,
          channel: "in_app",
          template_key: "incident_update",
          subject: `${config.brand_name}: an organization's permission was withdrawn`,
          body: `A rider has withdrawn an organization's permission to book for them. ${(inFlight ?? []).length} ride(s) are still open. Check with the rider directly before anything is cancelled.`,
          idempotency_key: idempotencyKey(["auth_withdrawn", authorizationId, d.user_id]),
          status: "queued",
          queued_at: nowIso,
        });
      }
    }

    await audit(ctx, {
      event_type: "participant_authorization.decide", action: decision === "decline" ? "reject" : "update",
      subject_entity: "OrganizationParticipantAuthorization", subject_id: authorizationId,
      from_state: authorization.status, to_state: target, reason_code: decision,
      metadata: { organization_id: authorization.organization_id, open_rides: (inFlight ?? []).length },
    });

    return ok({
      authorization_id: authorizationId,
      status: target,
      open_rides_flagged: (inFlight ?? []).length,
      message:
        decision === "decline"
          ? "Declined. They cannot request rides for you, and this has no effect on your own rides."
          : "Withdrawn. They can no longer request rides for you. Any ride already booked stays open until you or a coordinator changes it.",
    });
  } catch (e) {
    console.error("confirm_participant_authorization_failed", String(e));
    return serverError();
  }
}
