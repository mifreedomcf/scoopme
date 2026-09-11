/**
 * Open a masked calling and texting session between a rider and their driver.
 *
 * For a child's ride this always refuses: contact routes through the guardian
 * and the platform. For an adult ride with no relay provider configured, it
 * says so plainly rather than quietly handing out a real phone number.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { decideContactMode, relayExpiry, unavailableRelay } from "../../shared/relay.ts";

const REVEAL_LEAD_MS = 2 * 3_600_000;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    const rideId = String(body?.ride_request_id ?? "");
    if (!rideId) return fail("missing_fields", "ride_request_id is required.", 400);

    const sr = ctx.base44.asServiceRole.entities;
    const rides = await sr.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    const assignments = await sr.RideAssignment.filter({ ride_request_id: rideId, is_active: true });
    const assignment = (assignments ?? [])[0];
    if (!assignment) return fail("no_assignment", "Nobody is assigned to this ride yet.", 409);

    const isDriver = assignment.driver_user_id === ctx.principal.userId;
    const isRider = ride.rider_user_id === ctx.principal.userId;
    if (!isDriver && !isRider) return notFound("That ride does not exist.");

    const config = await loadConfig(ctx);
    const pickupMs = ride.requested_pickup_at ? new Date(ride.requested_pickup_at).getTime() : Number.MAX_SAFE_INTEGER;

    const decision = decideContactMode({
      riderKind: ride.rider_kind === "minor" ? "minor" : "adult",
      relayConfigured: config.relay_provider_mode === "live",
      rideStatus: String(ride.status),
      isAssignedDriver: isDriver || isRider,
      revealWindowOpen: Date.now() >= pickupMs - REVEAL_LEAD_MS,
    });

    await audit(ctx, {
      event_type: "relay.contact_mode", action: "read",
      subject_entity: "RideRequest", subject_id: rideId,
      reason_code: decision.code,
      metadata: { mode: decision.mode, rider_kind: ride.rider_kind },
    });

    if (decision.mode !== "relay") {
      return ok({
        mode: decision.mode,
        code: decision.code,
        message: decision.message,
        may_reveal_real_numbers: decision.mayRevealRealNumbers,
        use_in_app_messages: true,
      });
    }

    const now = new Date().toISOString();
    const existing = await sr.RelaySession.filter({ ride_request_id: rideId }, "-opened_at", 1);
    const live = (existing ?? [])[0];
    if (live && !live.revoked_at && !live.closed_at && live.expires_at > now) {
      return ok({ mode: "relay", relay_session_id: live.id, proxy_number: live.proxy_number, expires_at: live.expires_at });
    }

    const expiresAt = relayExpiry(ride.arrival_by_at, String(ride.requested_pickup_at ?? now), now);
    // Milestone 7 swaps in a live provider. Until then this reports unavailable
    // rather than inventing a number.
    const opened = await unavailableRelay.openSession(
      rideId, ride.rider_user_id, assignment.driver_user_id, expiresAt,
    );
    if (!opened.ok || !opened.proxy_number) {
      return ok({
        mode: "in_app_only",
        code: opened.errorCode ?? "relay_unavailable",
        message: "Masked calling is not working right now. Use in-app messages, or call the support line.",
        may_reveal_real_numbers: false,
        use_in_app_messages: true,
      });
    }

    const session = await sr.RelaySession.create({
      ride_request_id: rideId,
      provider_name: unavailableRelay.name,
      provider_session_id: opened.provider_session_id,
      proxy_number: opened.proxy_number,
      participant_a_user_id: ride.rider_user_id,
      participant_b_user_id: assignment.driver_user_id,
      channel: "both",
      opened_at: now,
      expires_at: expiresAt,
    });

    return ok({
      mode: "relay",
      relay_session_id: session.id,
      proxy_number: opened.proxy_number,
      expires_at: expiresAt,
      message: decision.message,
    }, 201);
  } catch (e) {
    console.error("open_relay_session_failed", String(e));
    return serverError();
  }
}
