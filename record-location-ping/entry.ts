/**
 * The assigned driver's app posts a point.
 *
 * Every ping is re-checked against the flag, the gates, the ride state and live
 * consent. Consent withdrawn thirty seconds ago stops the next one. No other
 * source of location is accepted, ever.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { checkGatesForFlag } from "../../shared/flags.ts";
import { acceptPing, mayCollectLocation } from "../../shared/tracking.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");

    const sr = ctx.base44.asServiceRole.entities;
    const rides = await sr.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    const assignments = await sr.RideAssignment.filter({ ride_request_id: rideId, is_active: true });
    const assignment = (assignments ?? [])[0];
    if (!assignment || assignment.driver_user_id !== ctx.principal.userId) {
      await audit(ctx, {
        event_type: "location.ping_denied", action: "create", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_assigned_driver",
      });
      return notFound("That ride does not exist.");
    }

    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const sessions = await sr.TrackingSession.filter({ ride_request_id: rideId }, "-granted_at", 1);
    const session = (sessions ?? [])[0] ?? null;
    const now = new Date().toISOString();

    const verdict = mayCollectLocation(
      {
        ride_request_id: rideId,
        ride_status: String(ride.status),
        started_at: session?.started_at,
        ended_at: session?.ended_at,
        consent: session
          ? {
              ride_request_id: rideId,
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
    if (!verdict.allowed) {
      // Not an error the driver caused. Tell their app to stop sending.
      return ok({ accepted: false, stop_sending: true, code: verdict.code, message: verdict.message });
    }

    const point = { lat: Number(body.latitude), lng: Number(body.longitude) };
    const check = acceptPing(point, session?.last_ping_at, now);
    if (!check.accepted) {
      return ok({ accepted: false, stop_sending: false, code: check.code, message: check.message });
    }

    await sr.LocationEvent.create({
      ride_request_id: rideId,
      tracking_session_id: session!.id,
      recorded_by_user_id: ctx.principal.userId,
      latitude: point.lat,
      longitude: point.lng,
      accuracy_meters: body.accuracy_meters !== undefined ? Number(body.accuracy_meters) : undefined,
      recorded_at: now,
      ride_status_at_capture: String(ride.status),
    });
    await sr.TrackingSession.update(session!.id, {
      last_ping_at: now,
      ping_count: Number(session!.ping_count ?? 0) + 1,
    });
    // A ping is also a sign of life, so it resets the silence timer.
    await sr.RideAssignment.update(assignment.id, { last_check_in_at: now });

    return ok({ accepted: true, stop_sending: false, next_ping_after_seconds: 30 });
  } catch (e) {
    console.error("record_location_ping_failed", String(e));
    return serverError();
  }
}
