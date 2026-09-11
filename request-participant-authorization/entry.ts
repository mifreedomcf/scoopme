/**
 * An organization asks a participant for permission to request rides for them.
 *
 * This creates a PENDING record and nothing more. The organization cannot make
 * it active, cannot confirm on the participant's behalf, and cannot use it
 * until the participant themselves confirms. Being someone's case manager,
 * teacher, or coach is not authorization.
 *
 * For anyone under 18 this route is closed outright: guardian consent is a
 * different thing entirely and lives in Milestone 4.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { idempotencyKey } from "../../shared/ids.ts";

/** How long an unconfirmed request stays open before it has to be re-asked. */
const REQUEST_TTL_DAYS = 14;
/** Maximum life of a confirmed authorization before the participant re-confirms. */
const AUTHORIZATION_TTL_DAYS = 365;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "org_scheduler") && !hasRole(ctx.principal, "org_admin")) {
      return forbidden("Only approved organization schedulers can ask for authorization.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const organizationId = String(body.organization_id ?? "");
    const participantEmail = String(body.participant_email ?? "").trim().toLowerCase();
    if (!organizationId || !participantEmail) {
      return fail("missing_fields", "organization_id and participant_email are required.", 400);
    }
    if (!ctx.principal.organizationIds.includes(organizationId)) {
      return forbidden("You are not an approved scheduler for that organization.");
    }

    const sr = ctx.base44.asServiceRole.entities;
    const orgs = await sr.Organization.filter({ id: organizationId }, undefined, 1);
    const org = (orgs ?? [])[0];
    if (!org || org.status !== "approved") return forbidden("That organization is not approved to schedule rides.");

    // The participant must already have an account. We do not create one for
    // them, and we do not confirm anything on their behalf.
    const profiles = await sr.UserProfile.filter({ email: participantEmail }, undefined, 1);
    const participant = (profiles ?? [])[0];
    if (!participant) {
      return fail(
        "participant_not_found",
        "We have no account for that email. Ask the person to sign up first — they have to give permission themselves.",
        404,
      );
    }

    // A minor cannot authorize an organization, and an organization can never
    // stand in for a guardian.
    const config = await loadConfig(ctx);
    const dob = participant.date_of_birth ? String(participant.date_of_birth) : "";
    const eighteenYearsAgo = new Date(Date.now() - 18 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    const looksLikeMinor = Boolean(dob) && dob > eighteenYearsAgo;
    if (looksLikeMinor || body.participant_is_minor === true) {
      await audit(ctx, {
        event_type: "participant_authorization.request", action: "create", outcome: "denied",
        reason_code: "minor_cannot_authorize",
      });
      return forbidden(
        "A person under 18 cannot authorize an organization, and an organization cannot consent for them. A verified parent or legal guardian has to do that separately.",
      );
    }
    if (!config.adult_rides_enabled) {
      return fail("adult_rides_disabled", "Ride requests are paused right now.", 409);
    }

    const now = new Date();
    const nowIso = now.toISOString();

    const existing = await sr.OrganizationParticipantAuthorization.filter({
      organization_id: organizationId, participant_user_id: participant.user_id,
    }, "-created_date", 5);
    const live = (existing ?? []).find(
      (a: Record<string, string>) => a.status === "active" && (!a.expires_at || a.expires_at > nowIso),
    );
    if (live) {
      return ok({
        authorization_id: live.id,
        status: "active",
        message: "This person has already given your organization permission.",
      });
    }
    const pending = (existing ?? []).find(
      (a: Record<string, string>) => a.status === "pending" && (!a.expires_at || a.expires_at > nowIso),
    );
    if (pending) {
      return ok({
        authorization_id: pending.id,
        status: "pending",
        message: "You have already asked. It is waiting on them, not on us.",
      });
    }

    const requestExpiry = new Date(now.getTime() + REQUEST_TTL_DAYS * 86_400_000).toISOString();
    const created = await sr.OrganizationParticipantAuthorization.create({
      organization_id: organizationId,
      participant_user_id: participant.user_id,
      authorization_type: "participant_signed",
      scope: body.scope === "request_and_receive_status" ? "request_and_receive_status" : "request_rides_only",
      // Pending. Only the participant can move this.
      status: "pending",
      expires_at: requestExpiry,
    });

    // Ask the participant, in app. Nothing about their situation is in the message.
    await sr.Notification.create({
      recipient_user_id: participant.user_id,
      recipient_email: participantEmail,
      channel: "in_app",
      template_key: "consent_needed",
      subject: `${config.brand_name}: ${org.name} would like to book rides for you`,
      body: `${org.name} has asked to request rides on your behalf. Nothing happens unless you say yes, and you can withdraw it at any time. Saying no does not affect your own rides at all.`,
      idempotency_key: idempotencyKey(["participant_authorization", created.id, participant.user_id]),
      status: "queued",
      queued_at: nowIso,
    });

    await audit(ctx, {
      event_type: "participant_authorization.request", action: "create",
      subject_entity: "OrganizationParticipantAuthorization", subject_id: created.id,
      metadata: { organization_id: organizationId, scope: created.scope, expires_at: requestExpiry },
    });

    return ok({
      authorization_id: created.id,
      status: "pending",
      expires_at: requestExpiry,
      authorization_ttl_days: AUTHORIZATION_TTL_DAYS,
      message:
        "Asked. They decide, not you — you will see it here once they confirm. You cannot request rides for them until then.",
    }, 201);
  } catch (e) {
    console.error("request_participant_authorization_failed", String(e));
    return serverError();
  }
}
