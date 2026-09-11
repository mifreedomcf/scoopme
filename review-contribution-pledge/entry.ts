/**
 * The operator accepts, declines, or acknowledges a pledge.
 *
 * A decline is a scheduling decision about the operator's own capacity to use
 * what was offered. It has no bearing on anyone's rides, and the response says
 * so out loud so nobody has to wonder.
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
    if (!hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only platform administrators can decide a pledge.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const pledgeId = String(body.pledge_id ?? "");
    const decision = String(body.decision ?? "");
    if (!["accept", "decline"].includes(decision)) {
      return fail("invalid_decision", "decision must be accept or decline.", 400);
    }

    const sr = ctx.base44.asServiceRole.entities;
    const rows = await sr.ContributionPledge.filter({ id: pledgeId }, undefined, 1);
    const pledge = (rows ?? [])[0];
    if (!pledge) return notFound("That pledge does not exist.");
    if (!["submitted", "draft"].includes(pledge.status)) {
      return fail("already_decided", "That pledge has already been decided.", 409);
    }

    const now = new Date().toISOString();
    const config = await loadConfig(ctx);
    const accepted = decision === "accept";

    await sr.ContributionPledge.update(pledgeId, {
      status: accepted ? "accepted" : "declined",
      decided_by_email: ctx.principal.email,
      decided_at: now,
      decline_reason: accepted ? "" : String(body.decline_reason ?? ""),
      acknowledged_at: now,
    });

    const rendered = renderTemplate("contribution_acknowledged", {
      brandName: String(config.brand_name),
      genericDestinationLabel: "",
    });
    await sr.Notification.create({
      recipient_user_id: pledge.pledged_by_user_id,
      recipient_email: pledge.pledged_by_email,
      channel: "in_app",
      template_key: "contribution_acknowledged",
      subject: rendered.subject,
      body: accepted
        ? rendered.body
        : `Thank you for offering. We are not able to take this one up right now. It is voluntary, and this has no effect on anyone's access to a ride.`,
      idempotency_key: idempotencyKey(["contribution_decided", pledgeId, pledge.pledged_by_user_id]),
      status: "queued",
      queued_at: now,
    });

    await audit(ctx, {
      event_type: "contribution.pledge_decided", action: accepted ? "approve" : "reject",
      subject_entity: "ContributionPledge", subject_id: pledgeId,
      from_state: pledge.status, to_state: accepted ? "accepted" : "declined",
      reason_code: accepted ? "accepted" : String(body.decline_reason ?? "declined"),
    });

    return ok({
      pledge_id: pledgeId,
      status: accepted ? "accepted" : "declined",
      rider_access_effect: "none",
      message: accepted
        ? "Accepted, with thanks."
        : "Declined. Nothing about anyone's rides changes because of this.",
    });
  } catch (e) {
    console.error("review_contribution_pledge_failed", String(e));
    return serverError();
  }
}
