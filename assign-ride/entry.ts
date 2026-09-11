/**
 * Direct dispatcher assignment of a specific driver to a ride.
 *
 * Uses the same lock as claim-ride, and re-runs the same eligibility filters —
 * a dispatcher cannot assign an ineligible or expired driver.
 */
import { conflict, fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { canFulfillRides } from "../../shared/flags.ts";
import { evaluateDriver } from "../../shared/matching.ts";
import { secureToken } from "../../shared/ids.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "dispatcher") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only dispatchers can assign rides.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");
    const driverProfileId = String(body.driver_profile_id ?? "");
    if (!rideId || !driverProfileId) return fail("missing_fields", "ride_request_id and driver_profile_id are required.", 400);

    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const fulfillment = canFulfillRides(config, gates, todayISO());
    if (!fulfillment.allowed) return fail(fulfillment.code, fulfillment.message, 409);

    const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");
    if (!["approved", "offered", "driver_canceled"].includes(ride.status)) {
      return conflict("ride_not_assignable", `A ${ride.status} ride cannot be assigned.`);
    }

    const existing = await ctx.base44.asServiceRole.entities.RideAssignment.filter({ ride_request_id: rideId, is_active: true });
    if ((existing ?? []).length > 0) return conflict("already_claimed", "This ride already has an active driver.");

    const drivers = await ctx.base44.asServiceRole.entities.DriverProfile.filter({ id: driverProfileId }, undefined, 1);
    const driver = (drivers ?? [])[0];
    if (!driver) return notFound("That driver does not exist.");

    const today = todayISO();
    const [credentials, vehicles, capabilities, availability, needs] = await Promise.all([
      ctx.base44.asServiceRole.entities.DriverCredential.filter({ driver_profile_id: driver.id }),
      ctx.base44.asServiceRole.entities.Vehicle.filter({ driver_profile_id: driver.id, status: "active" }),
      ctx.base44.asServiceRole.entities.VehicleCapability.filter({ driver_profile_id: driver.id }),
      ctx.base44.asServiceRole.entities.DriverAvailability.filter({ driver_profile_id: driver.id, status: "active" }),
      ctx.base44.asServiceRole.entities.RideNeed.filter({ ride_request_id: rideId }),
    ]);
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
        event_type: "ride.assign", action: "transition", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "driver_ineligible",
        metadata: { failures: verdict.failures.join(",") },
      });
      return fail("driver_ineligible", `That driver cannot take this ride: ${verdict.failures.join(", ")}`, 409);
    }

    const now = new Date().toISOString();
    const assignment = await ctx.base44.asServiceRole.entities.RideAssignment.create({
      ride_request_id: rideId,
      driver_profile_id: driver.id,
      driver_user_id: driver.user_id,
      vehicle_id: vehicle?.id,
      assignment_kind: "dispatcher_assignment",
      assigned_by_email: ctx.principal.email,
      claim_token: secureToken(16),
      is_active: true,
      reveal_window_opens_at: ride.requested_pickup_at,
    });

    await ctx.base44.asServiceRole.entities.RideRequest.update(rideId, { status: "claimed", status_reason_code: "dispatcher_assignment" });
    await ctx.base44.asServiceRole.entities.RideOffer.updateMany(
      { ride_request_id: rideId, status: "open" },
      { $set: { status: "withdrawn", responded_at: now } },
    );
    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: rideId, event_type: "transition", from_state: ride.status, to_state: "claimed",
      actor_user_id: ctx.principal.userId, actor_role: "dispatcher",
      reason_code: "dispatcher_assignment", occurred_at: now,
    });
    await audit(ctx, {
      event_type: "ride.assign", action: "transition", subject_entity: "RideRequest", subject_id: rideId,
      from_state: ride.status, to_state: "claimed", metadata: { driver_profile_id: driver.id, assignment_id: assignment.id },
    });

    return ok({ ride_request_id: rideId, assignment_id: assignment.id, status: "claimed" });
  } catch (e) {
    console.error("assign_ride_failed", String(e));
    return serverError();
  }
}
