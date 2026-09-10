/**
 * The single read path for ride detail.
 *
 * Every caller gets exactly the projection their relationship to the ride
 * allows. Access to exact addresses is time-boxed and audited.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { minimizeRide } from "../../shared/minimize.ts";
import { viewerKindFor } from "../../shared/authz.ts";

/** How long before pickup exact details unlock for the assigned driver. */
const REVEAL_LEAD_MS = 2 * 3_600_000;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    const rideId = String(body?.ride_request_id ?? "");
    if (!rideId) return fail("missing_fields", "ride_request_id is required.", 400);

    const rides = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    const assignments = await ctx.base44.asServiceRole.entities.RideAssignment.filter({ ride_request_id: rideId, is_active: true });
    const assignment = (assignments ?? [])[0] ?? null;
    const isAssignedDriver = Boolean(assignment) && assignment.driver_user_id === ctx.principal.userId;

    const viewer = viewerKindFor(ctx.principal, ride, isAssignedDriver);
    if (viewer === "public") {
      // Do not confirm the existence of someone else's ride.
      await audit(ctx, {
        event_type: "ride.read", action: "read", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_authorized",
      });
      return notFound("That ride does not exist.");
    }

    const now = Date.now();
    const pickupMs = ride.requested_pickup_at ? new Date(ride.requested_pickup_at).getTime() : Number.MAX_SAFE_INTEGER;
    const revealWindowOpen =
      isAssignedDriver &&
      ["confirmed", "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff"].includes(ride.status) &&
      now >= pickupMs - REVEAL_LEAD_MS;
    const rideCompleted = ["completed", "canceled", "driver_canceled", "closed_by_admin", "rider_no_show"].includes(ride.status);

    const payload = minimizeRide(ride, { viewer, revealWindowOpen, rideCompleted });

    // Reveal of exact location is a logged event, once per assignment.
    if (revealWindowOpen && assignment && !assignment.details_revealed_at) {
      await ctx.base44.asServiceRole.entities.RideAssignment.update(assignment.id, {
        details_revealed_at: new Date().toISOString(),
      });
      await audit(ctx, {
        event_type: "location.reveal", action: "read", subject_entity: "RideRequest", subject_id: rideId,
        reason_code: "assigned_driver_reveal_window_open",
      });
    } else if (viewer === "dispatcher" || viewer === "safety_staff" || viewer === "platform_admin") {
      await audit(ctx, {
        event_type: "ride.read", action: "read", subject_entity: "RideRequest", subject_id: rideId,
        reason_code: `staff_view:${viewer}`,
      });
    }

    const config = await loadConfig(ctx);
    let driverCard = null;
    if (assignment && ["rider", "guardian", "org_scheduler"].includes(viewer)) {
      const dp = await ctx.base44.asServiceRole.entities.DriverProfile.filter({ id: assignment.driver_profile_id }, undefined, 1);
      const vehicles = assignment.vehicle_id
        ? await ctx.base44.asServiceRole.entities.Vehicle.filter({ id: assignment.vehicle_id }, undefined, 1)
        : [];
      const d = (dp ?? [])[0];
      const v = (vehicles ?? [])[0];
      // The rider sees exactly what they need to identify the car and no more.
      driverCard = d
        ? {
            display_name: d.display_name,
            photo_url: d.photo_url ?? null,
            vehicle: v ? { make: v.make, model: v.model, year: v.year, color: v.color, plate: v.license_plate } : null,
          }
        : null;
    }

    return ok({
      viewer,
      ride: payload,
      driver_card: driverCard,
      reveal_window_open: Boolean(revealWindowOpen),
      emergency: {
        call_911_prominent: true,
        safety_team_phone: config.safety_phone || null,
        note: "For an emergency, call 911. This app does not replace emergency services.",
      },
    });
  } catch (e) {
    console.error("reveal_ride_details_failed", String(e));
    return serverError();
  }
}
