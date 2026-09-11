/**
 * The outage fallback: a printable manifest of the day's confirmed rides.
 *
 * This is the most sensitive export in the product — it deliberately contains
 * exact addresses, phone numbers, and verification codes, because a dispatcher
 * with no working app needs all three. So it requires a staff role, a written
 * purpose, and a date range, and every export is audited with what was pulled.
 */
import { fail, forbidden, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

const MANIFEST_STATES = ["confirmed", "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff"];
const MAX_RANGE_HOURS = 48;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "dispatcher") && !hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only dispatch and safety staff can export a ride manifest.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const purpose = String(body.purpose ?? "").trim();
    if (purpose.length < 15) {
      return fail("purpose_required", "Write why you need this export. At least 15 characters.", 400);
    }
    const from = String(body.from ?? "");
    const to = String(body.to ?? "");
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || toDate <= fromDate) {
      return fail("invalid_range", "Give a from and to time, with to after from.", 400);
    }
    if ((toDate.getTime() - fromDate.getTime()) / 3_600_000 > MAX_RANGE_HOURS) {
      return fail("range_too_wide", `Export at most ${MAX_RANGE_HOURS} hours at a time.`, 400);
    }

    const sr = ctx.base44.asServiceRole.entities;
    const config = await loadConfig(ctx);
    const rides = await sr.RideRequest.filter(
      { status: { $in: MANIFEST_STATES }, requested_pickup_at: { $gte: from, $lte: to } },
      "requested_pickup_at", 300,
    );

    const rows = [];
    for (const ride of rides ?? []) {
      const assignments = await sr.RideAssignment.filter({ ride_request_id: ride.id, is_active: true });
      const assignment = (assignments ?? [])[0];
      let driver = null;
      let vehicle = null;
      if (assignment) {
        driver = ((await sr.DriverProfile.filter({ id: assignment.driver_profile_id }, undefined, 1)) ?? [])[0] ?? null;
        if (assignment.vehicle_id) {
          vehicle = ((await sr.Vehicle.filter({ id: assignment.vehicle_id }, undefined, 1)) ?? [])[0] ?? null;
        }
      }
      const needs = await sr.RideNeed.filter({ ride_request_id: ride.id });

      rows.push({
        ride_id: ride.id,
        pickup_at: ride.requested_pickup_at,
        arrive_by: ride.arrival_by_at,
        pickup_address: ride.pickup_address,
        destination: ride.destination_area_label,
        destination_address: ride.destination_address,
        rider_phone: ride.contact_phone,
        passengers: ride.passenger_count,
        assistance_level: ride.assistance_level,
        needs: (needs ?? []).map((n: { need: string }) => n.need),
        verification_code: ride.verification_code,
        driver_name: driver?.display_name ?? "UNASSIGNED",
        driver_phone: driver?.phone ?? "",
        vehicle: vehicle ? `${vehicle.color} ${vehicle.year} ${vehicle.make} ${vehicle.model}, plate ${vehicle.license_plate}` : "",
        status: ride.status,
      });
    }

    await audit(ctx, {
      event_type: "export.sensitive", action: "export",
      subject_entity: "RideRequest",
      justification: purpose,
      metadata: { from, to, row_count: rows.length, export_kind: "outage_ride_manifest" },
    });

    return ok({
      generated_at: new Date().toISOString(),
      generated_by: ctx.principal.email,
      purpose,
      range: { from, to },
      operator: config.operator_legal_name,
      safety_phone: config.safety_phone || null,
      row_count: rows.length,
      rows,
      handling_notice:
        "This document contains home addresses, phone numbers, and ride verification codes. Keep it locked while in use and shred it at the end of the day. Your name, the time, and your stated purpose have been recorded.",
    });
  } catch (e) {
    console.error("export_ride_manifest_failed", String(e));
    return serverError();
  }
}
