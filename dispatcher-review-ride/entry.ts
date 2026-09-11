/**
 * Dispatcher review: approve, waitlist, or decline a request, and publish
 * minimized offers to eligible drivers.
 *
 * Approval is always a human decision. The matcher only proposes.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { canFulfillRides } from "../../shared/flags.ts";
import { rankEligibleDrivers } from "../../shared/matching.ts";
import { evaluateMinorRide } from "../../shared/minor-runtime.ts";
import { canTransition } from "../../shared/state-machine.ts";
import type { RideState } from "../../shared/constants.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "dispatcher") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only dispatchers can review requests.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");
    const decision = String(body.decision ?? "");
    const reasonCode = body.reason_code ? String(body.reason_code) : undefined;
    const publishOffers = body.publish_offers !== false;

    if (!["approve", "waitlist", "decline"].includes(decision)) {
      return fail("invalid_decision", "decision must be approve, waitlist, or decline.", 400);
    }

    const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    // A child's ride cannot be approved until every requirement holds. The
    // dispatcher sees the whole list, not the first thing that failed.
    if (decision === "approve" && ride.rider_kind === "minor") {
      const config = await loadConfig(ctx);
      const gates = await loadGates(ctx);
      const minorVerdict = await evaluateMinorRide(ctx, ride, config, gates, todayISO());
      if (!minorVerdict.allowed) {
        await audit(ctx, {
          event_type: "minor.gate_blocked", action: "approve", outcome: "denied",
          subject_entity: "RideRequest", subject_id: rideId,
          reason_code: minorVerdict.blocking[0]?.code ?? "minor_gate_blocked",
          metadata: { blocking: minorVerdict.blocking.map((b) => b.code).join(",") },
        });
        return fail(
          "minor_ride_blocked",
          "This ride cannot be approved yet.",
          409,
          minorVerdict.blocking.map((b) => ({ field: "minor_requirements", code: b.code, message: b.message })),
        );
      }
    }

    const target: RideState = decision === "approve" ? "approved" : decision === "waitlist" ? "waitlisted" : "canceled";
    const gate = canTransition(ride.status as RideState, target, {
      actorRole: hasRole(ctx.principal, "platform_admin") ? "platform_admin" : "dispatcher",
      reasonCode: reasonCode ?? (decision === "approve" ? undefined : "dispatcher_decision"),
    });
    if (!gate.allowed) return fail(gate.code, gate.message, 409);

    const now = new Date().toISOString();
    await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, {
      status: target,
      status_reason_code: reasonCode ?? "dispatcher_decision",
      approved_at: target === "approved" ? now : undefined,
      canceled_at: target === "canceled" ? now : undefined,
    });
    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: rideId, event_type: "transition", from_state: ride.status, to_state: target,
      actor_user_id: ctx.principal.userId, actor_role: "dispatcher",
      reason_code: reasonCode ?? "dispatcher_decision", occurred_at: now,
    });
    await audit(ctx, {
      event_type: "ride.review", action: decision === "decline" ? "reject" : "approve",
      subject_entity: "RideRequest", subject_id: rideId, from_state: ride.status, to_state: target,
      reason_code: reasonCode,
    });

    if (target !== "approved" || !publishOffers) {
      return ok({ ride_request_id: rideId, status: target, offers_published: 0 });
    }

    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const fulfillment = canFulfillRides(config, gates, todayISO());
    if (!fulfillment.allowed) {
      return ok({
        ride_request_id: rideId, status: "approved", offers_published: 0,
        message: "Approved, but no offers were published: " + fulfillment.message,
      });
    }

    // Build driver snapshots and run the deterministic matcher.
    const driverRows = await ctx.base44.asServiceRole.entities.DriverProfile.filter({ eligibility_status: "eligible" }, undefined, 500);
    const needs = await ctx.base44.asServiceRole.entities.RideNeed.filter({ ride_request_id: rideId });
    const today = todayISO();

    const snapshots = [];
    for (const d of driverRows ?? []) {
      const [credentials, vehicles, capabilities, availability, booked] = await Promise.all([
        ctx.base44.asServiceRole.entities.DriverCredential.filter({ driver_profile_id: d.id }),
        ctx.base44.asServiceRole.entities.Vehicle.filter({ driver_profile_id: d.id, status: "active" }),
        ctx.base44.asServiceRole.entities.VehicleCapability.filter({ driver_profile_id: d.id }),
        ctx.base44.asServiceRole.entities.DriverAvailability.filter({ driver_profile_id: d.id, status: "active" }),
        ctx.base44.asServiceRole.entities.RideAssignment.filter({ driver_profile_id: d.id, is_active: true }),
      ]);
      const vehicle = (vehicles ?? [])[0];
      const bookedWindows = [];
      for (const a of booked ?? []) {
        const r = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: a.ride_request_id }, undefined, 1);
        const rr = (r ?? [])[0];
        if (rr && rr.id !== rideId && rr.requested_pickup_at) {
          bookedWindows.push({
            starts_at: rr.requested_pickup_at,
            ends_at: rr.arrival_by_at ?? rr.requested_pickup_at,
          });
        }
      }
      snapshots.push({
        driver_profile_id: d.id,
        approval_tier: d.approval_tier,
        eligibility_status: d.eligibility_status,
        languages: d.languages ?? ["en"],
        accepts_service_animals: d.accepts_service_animals ?? true,
        max_travel_miles: d.max_travel_miles ?? 15,
        credentials: credentials ?? [],
        capabilities: capabilities ?? [],
        availability: availability ?? [],
        bookedWindows,
        vehicleSeatingCapacity: vehicle?.seating_capacity ?? 0,
        vehicleStatus: vehicle?.status ?? "none",
        vehicleInspectionOk: !vehicle?.inspection_required || vehicle?.inspection_status === "passed",
      });
    }

    const ranked = rankEligibleDrivers(
      snapshots,
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

    // Offers carry approximate area only. No address, no contact, no code.
    for (const match of ranked) {
      await ctx.base44.asServiceRole.entities.RideOffer.create({
        ride_request_id: rideId,
        driver_profile_id: match.driver.driver_profile_id,
        offer_kind: "broadcast",
        pickup_area_label: ride.pickup_area_label,
        destination_area_label: ride.destination_area_label,
        resource_category: ride.resource_category,
        window_start: ride.requested_pickup_at,
        window_end: ride.arrival_by_at ?? ride.requested_pickup_at,
        passenger_count: ride.passenger_count ?? 1,
        required_capabilities: (needs ?? []).map((n: { need: string }) => n.need),
        approx_distance_miles: match.distanceMiles ?? undefined,
        status: "open",
        match_explanation: match.verdict.passed,
      });
    }

    if (ranked.length > 0) {
      await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, { status: "offered" });
      await ctx.base44.asServiceRole.entities.RideEvent.create({
        ride_request_id: rideId, event_type: "offer_sent", from_state: "approved", to_state: "offered",
        actor_user_id: ctx.principal.userId, actor_role: "dispatcher",
        reason_code: "offers_published", occurred_at: now,
      });
    }

    return ok({
      ride_request_id: rideId,
      status: ranked.length > 0 ? "offered" : "approved",
      offers_published: ranked.length,
    });
  } catch (e) {
    console.error("dispatcher_review_failed", String(e));
    return serverError();
  }
}
