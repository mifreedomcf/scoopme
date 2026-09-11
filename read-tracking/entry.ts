/**
 * Read a ride's location through a tracking token.
 *
 * The token is the authorization. It is unguessable, scoped to one ride and one
 * audience, expires with the trip, and is rate limited. Every read is written to
 * AuditLog. Once the ride is over the answer becomes a coarse last-known point
 * with no trail — the link keeps working briefly, but it stops being precise.
 */
import { fail, notFound, ok, readJson, serverError } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { checkGatesForFlag } from "../../shared/flags.ts";
import { checkTrackingAccess, trackingPayload, TRACKING_READ_RATE_PER_MINUTE } from "../../shared/tracking.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    const body = await readJson(req);
    const token = String(body?.token ?? "");
    if (!token || token.length < 32) return notFound("That link is not valid.");

    const sr = ctx.base44.asServiceRole.entities;
    const links = await sr.TrackingLink.filter({ token }, undefined, 1);
    const link = (links ?? [])[0];
    // A bad token and a revoked token look identical from outside.
    if (!link) return notFound("That link is not valid.");

    const now = new Date().toISOString();
    const nowMs = Date.now();

    // Sliding one-minute window, per token.
    const windowStart = link.reads_window_started_at ? new Date(link.reads_window_started_at).getTime() : 0;
    const freshWindow = nowMs - windowStart > 60_000;
    const readsInWindow = freshWindow ? 0 : Number(link.reads_in_window ?? 0);

    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const rides = await sr.RideRequest.filter({ id: link.ride_request_id }, undefined, 1);
    const ride = (rides ?? [])[0];
    const sessions = await sr.TrackingSession.filter({ id: link.tracking_session_id }, undefined, 1);
    const session = (sessions ?? [])[0] ?? null;

    const verdict = checkTrackingAccess(
      {
        token,
        ride_request_id: link.ride_request_id,
        audience: link.audience,
        issued_to_user_id: link.issued_to_user_id,
        issued_at: link.issued_at,
        expires_at: link.expires_at,
        revoked_at: link.revoked_at,
        reads_in_current_minute: readsInWindow,
      },
      {
        ride_request_id: link.ride_request_id,
        ride_status: String(ride?.status ?? "unknown"),
        started_at: session?.started_at,
        ended_at: session?.ended_at,
        consent: session
          ? {
              ride_request_id: link.ride_request_id,
              granted_by_user_id: session.granted_by_user_id,
              granted_at: session.granted_at,
              revoked_at: session.revoked_at,
              audiences: session.audiences ?? [],
            }
          : null,
        liveLocationEnabled: config.live_location_enabled === true,
        gatesSatisfied: checkGatesForFlag("live_location_enabled", gates, todayISO()).satisfied,
      },
      now,
    );

    await sr.TrackingLink.update(link.id, {
      read_count: Number(link.read_count ?? 0) + 1,
      last_read_at: now,
      reads_window_started_at: freshWindow ? now : link.reads_window_started_at,
      reads_in_window: readsInWindow + 1,
    });

    await audit(ctx, {
      event_type: "location.read", action: "read",
      outcome: verdict.allowed ? "allowed" : "denied",
      subject_entity: "TrackingLink", subject_id: link.id,
      reason_code: verdict.code,
      metadata: { audience: link.audience, ride_request_id: link.ride_request_id, precise: verdict.allowed && !verdict.coarseOnly },
    });

    if (!verdict.allowed) {
      const status = verdict.code === "rate_limited" ? 429 : 403;
      return fail(verdict.code, verdict.message, status);
    }

    const events = await sr.LocationEvent.filter(
      { ride_request_id: link.ride_request_id }, "recorded_at", 50,
    );
    const points = (events ?? []).map((e: Record<string, unknown>) => ({
      point: { lat: Number(e.latitude), lng: Number(e.longitude) },
      recorded_at: String(e.recorded_at),
    }));

    const payload = trackingPayload(points, verdict);

    return ok({
      ride_request_id: link.ride_request_id,
      audience: link.audience,
      ride_status: ride?.status ?? "unknown",
      ...payload,
      expires_at: link.expires_at,
      reads_remaining_this_minute: Math.max(0, TRACKING_READ_RATE_PER_MINUTE - readsInWindow - 1),
      notice: verdict.coarseOnly
        ? "This ride has finished, so this shows roughly where it ended rather than a live position."
        : "This link expires with the trip. Do not forward it.",
    });
  } catch (e) {
    console.error("read_tracking_failed", String(e));
    return serverError();
  }
}
