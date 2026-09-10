/**
 * A driver claims an open offer.
 *
 * Two drivers must never hold one ride. The lock is a conditional write:
 * we create the RideAssignment first, then re-read every active assignment for
 * the ride and keep only the earliest claim token. A loser is released
 * immediately and told the ride is gone.
 */
import { conflict, fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { canFulfillRides } from "../../shared/flags.ts";
import { hasRole } from "../../shared/authz.ts";
import { evaluateDriver } from "../../shared/matching.ts";
import { secureToken } from "../../shared/ids.ts";
import { canTransition } from "../../shared/state-machine.ts";
import type { RideState } from "../../shared/constants.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "volunteer_driver")) return forbidden("Only approved volunteer drivers can claim rides.");

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");
    if (!rideId) return fail("missing_fields", "ride_request_id is required.", 400);

    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const fulfillment = canFulfillRides(config, gates, todayISO());
    if (!fulfillment.allowed) return fail(fulfillment.code, fulfillment.message, 409);

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter(
      { user_id: ctx.principal.userId }, undefined, 1,
    );
    const driver = (profiles ?? [])[0];
    if (!driver) return forbidden("You do not have an approved driver profile.");

    // Eligibility is recomputed here from live credential state. An expired
    // credential means the claim fails even if the offer was sent earlier.
    const today = todayISO();
    const credentials = await ctx.base44.asServiceRole.entities.DriverCredential.filter({ driver_profile_id: driver.id });
    const vehicles = await ctx.base44.asServiceRole.entities.Vehicle.filter({ driver_profile_id: driver.id, status: "active" });
    const capabilities = await ctx.base44.asServiceRole.entities.VehicleCapability.filter({ driver_profile_id: driver.id });
    const availability = await ctx.base44.asServiceRole.entities.DriverAvailability.filter({ driver_profile_id: driver.id, status: "active" });

    const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride is no longer available.");

    const offers = await ctx.base44.asServiceRole.entities.RideOffer.filter({
      ride_request_id: rideId, driver_profile_id: driver.id, status: "open",
    });
    if ((offers ?? []).length === 0) {
      return notFound("That ride is no longer available.");
    }

    const needs = await ctx.base44.asServiceRole.entities.RideNeed.filter({ ride_request_id: rideId });
    const vehicle = (vehicles ?? [])[0];
    const verdict = evaluateDriver(
      {
        driver_profile_id: driver.id,
        approval_tier: driver.approval_tier,
        eligibility_status: driver.eligibility_status,
        languages: driver.languages ?? ["en"],
        accepts_service_animals: driver.accepts_service_animals ?? true,
        max_travel_miles: driver.max_travel_miles ?? 15,
        credentials: credentials ?? [],
        capabilities: capabilities ?? [],
        availability: availability ?? [],
        bookedWindows: [],
        vehicleSeatingCapacity: vehicle?.seating_capacity ?? 0,
        vehicleStatus: vehicle?.status ?? "none",
        vehicleInspectionOk: !vehicle?.inspection_required || vehicle?.inspection_status === "passed",
      },
      {
        riderKind: ride.rider_kind === "minor" ? "minor" : "adult",
        passengerCount: ride.passenger_count ?? 1,
        windowStart: ride.requested_pickup_at,
        windowEnd: ride.arrival_by_at ?? ride.requested_pickup_at,
        languagePreference: ride.language_preference,
        serviceAnimal: Boolean(ride.service_animal),
        needs: (needs ?? []).map((n: Record<string, unknown>) => ({
          need: String(n.need), detail: n.detail as string | undefined,
          quantity: Number(n.quantity ?? 1), is_hard_requirement: n.is_hard_requirement !== false,
        })),
        maxVolunteerTravelMiles: Number(config.max_volunteer_travel_miles),
      },
      today,
    );
    if (!verdict.eligible) {
      await audit(ctx, {
        event_type: "ride.claim", action: "transition", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId,
        reason_code: "driver_ineligible", metadata: { failures: verdict.failures.join(",") },
      });
      return forbidden("You are not currently eligible for this ride. Check your credentials page.");
    }

    const gate = canTransition(ride.status as RideState, "claimed", {
      actorRole: "driver", isAssignedDriver: false, isRideParty: false,
    });
    if (!gate.allowed) return conflict("ride_not_claimable", "That ride is no longer available.");

    // --- Lock ---
    const token = secureToken(16);
    const claimedAt = new Date().toISOString();
    const assignment = await ctx.base44.asServiceRole.entities.RideAssignment.create({
      ride_request_id: rideId,
      driver_profile_id: driver.id,
      driver_user_id: ctx.principal.userId,
      vehicle_id: vehicle?.id,
      assignment_kind: "driver_claim",
      claim_token: token,
      is_active: true,
      reveal_window_opens_at: ride.requested_pickup_at,
    });

    const allActive = await ctx.base44.asServiceRole.entities.RideAssignment.filter({
      ride_request_id: rideId, is_active: true,
    });
    const sorted = [...(allActive ?? [])].sort((a, b) =>
      String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)),
    );
    const winner = sorted[0];

    if (!winner || winner.id !== assignment.id) {
      await ctx.base44.asServiceRole.entities.RideAssignment.update(assignment.id, {
        is_active: false, released_at: claimedAt, release_reason_code: "lost_claim_race",
      });
      await audit(ctx, {
        event_type: "ride.claim", action: "transition", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "lost_claim_race",
      });
      return conflict("already_claimed", "Another driver took this ride a moment ago.");
    }

    await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, {
      status: "claimed", status_reason_code: "driver_claim",
    });
    await ctx.base44.asServiceRole.entities.RideOffer.updateMany(
      { ride_request_id: rideId, status: "open" },
      { $set: { status: "withdrawn", responded_at: claimedAt } },
    );
    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: rideId, event_type: "transition", from_state: ride.status, to_state: "claimed",
      actor_user_id: ctx.principal.userId, actor_role: "driver", reason_code: "driver_claim",
      occurred_at: claimedAt,
    });
    await audit(ctx, {
      event_type: "ride.claim", action: "transition", subject_entity: "RideRequest", subject_id: rideId,
      from_state: ride.status, to_state: "claimed",
      metadata: { assignment_id: assignment.id, passed: verdict.passed.join(",") },
    });

    return ok({
      ride_request_id: rideId,
      assignment_id: assignment.id,
      status: "claimed",
      message: "You have this ride. Exact address and contact details unlock closer to pickup time.",
    });
  } catch (e) {
    console.error("claim_ride_failed", String(e));
    return serverError();
  }
}
