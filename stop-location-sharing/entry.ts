/**
 * Turn location sharing off.
 *
 * Immediate, no reason asked for, never refused. Revokes the session and every
 * token minted from it, so a link someone already has stops working straight
 * away rather than at its expiry.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    const rideId = String(body?.ride_request_id ?? "");
    if (!rideId) return fail("missing_fields", "ride_request_id is required.", 400);

    const sr = ctx.base44.asServiceRole.entities;
    const sessions = await sr.TrackingSession.filter({ ride_request_id: rideId }, "-granted_at", 1);
    const session = (sessions ?? [])[0];
    if (!session) return notFound("Location is not being shared on that ride.");

    // The grantor may always stop it. Safety staff may stop it too — turning it
    // off is never the risky direction.
    const isGrantor = session.granted_by_user_id === ctx.principal.userId;
    const isSafety = hasRole(ctx.principal, "safety_staff") || hasRole(ctx.principal, "platform_admin");
    if (!isGrantor && !isSafety) return notFound("Location is not being shared on that ride.");

    const now = new Date().toISOString();
    await sr.TrackingSession.update(session.id, { revoked_at: now, ended_at: now });
    await sr.TrackingLink.updateMany(
      { tracking_session_id: session.id },
      { $set: { revoked_at: now } },
    );

    await audit(ctx, {
      event_type: "location.consent_revoked", action: "update",
      subject_entity: "TrackingSession", subject_id: session.id,
      metadata: { ride_request_id: rideId, revoked_by: isGrantor ? "grantor" : "safety_staff" },
    });

    return ok({
      tracking_session_id: session.id,
      status: "off",
      message: "Location sharing is off. Any link that was shared has stopped working. Your ride is unaffected.",
    });
  } catch (e) {
    console.error("stop_location_sharing_failed", String(e));
    return serverError();
  }
}
