/**
 * A driver registers or updates a vehicle and declares its accommodations.
 *
 * The driver's own declaration is recorded as `self_reported`. It is never
 * enough to satisfy a rider's access need — only a staff verification in
 * `review-vehicle` promotes it, and the matcher reads only verified rows.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import { inspectionRequired } from "../../shared/eligibility.ts";
import { validateUpload } from "../../shared/uploads.ts";

const CAPABILITIES = [
  "wheelchair_lift", "wheelchair_ramp", "wheelchair_securement", "booster_seat",
  "forward_facing_car_seat", "rear_facing_car_seat", "service_animal_ok",
  "extra_passenger_space", "step_stool", "oxygen_tank_space",
];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter(
      { user_id: ctx.principal.userId }, undefined, 1,
    );
    const profile = (profiles ?? [])[0];
    if (!profile) return forbidden("Start a driver application first.");

    const config = await loadConfig(ctx);
    const today = todayISO();
    const year = Number(body.year ?? 0);
    const errors: { field: string; code: string; message: string }[] = [];

    if (!Number.isInteger(year) || year < 1980 || year > Number(today.slice(0, 4)) + 1) {
      errors.push({ field: "year", code: "invalid_year", message: "Enter the vehicle's year." });
    }
    const seats = Number(body.seating_capacity ?? 0);
    if (!Number.isInteger(seats) || seats < 2 || seats > 15) {
      errors.push({ field: "seating_capacity", code: "out_of_range", message: "Enter how many people the car seats, including you." });
    }
    for (const field of ["make", "model", "color", "license_plate"]) {
      if (!body[field] || String(body[field]).trim().length === 0) {
        errors.push({ field, code: "required", message: "This is needed so a rider can recognise your car." });
      }
    }
    for (const photo of (body.photos ?? []) as { filename?: string; content_type?: string; size_bytes?: number }[]) {
      const verdict = validateUpload({
        filename: String(photo.filename ?? ""),
        contentType: String(photo.content_type ?? ""),
        sizeBytes: Number(photo.size_bytes ?? 0),
        purpose: "vehicle_photo",
      });
      if (!verdict.ok) errors.push({ field: "photos", code: verdict.code, message: verdict.message });
    }
    for (const ref of (body.photo_references ?? []) as string[]) {
      if (/^https?:\/\//i.test(ref)) {
        errors.push({ field: "photo_references", code: "public_url_rejected", message: "Vehicle photos must be private uploads, not links." });
      }
    }
    if (errors.length > 0) return fail("validation_failed", "A few details need fixing.", 400, errors);

    const needsInspection = inspectionRequired(year, Number(config.vehicle_inspection_age_years), today);

    const patch = {
      driver_profile_id: profile.id,
      make: String(body.make),
      model: String(body.model),
      year,
      color: String(body.color),
      license_plate: String(body.license_plate).toUpperCase(),
      plate_state: body.plate_state ? String(body.plate_state).toUpperCase() : "MI",
      seating_capacity: seats,
      photo_references: (body.photo_references ?? []) as string[],
      photo_scan_status: (body.photo_references ?? []).length > 0 ? "pending" : "not_applicable",
      inspection_required: needsInspection,
      // A driver can never move their own vehicle to active.
      status: "pending_review",
    };

    const vehicleId = body.vehicle_id ? String(body.vehicle_id) : "";
    let id: string;
    if (vehicleId) {
      const rows = await ctx.base44.asServiceRole.entities.Vehicle.filter({ id: vehicleId }, undefined, 1);
      const vehicle = (rows ?? [])[0];
      if (!vehicle || vehicle.driver_profile_id !== profile.id) return notFound("That vehicle does not exist.");
      await ctx.base44.asServiceRole.entities.Vehicle.update(vehicleId, patch);
      id = vehicleId;
    } else {
      const created = await ctx.base44.asServiceRole.entities.Vehicle.create(patch);
      id = created.id;
    }

    // Declared capabilities are recorded, unverified.
    const declared = ((body.capabilities ?? []) as { capability: string; quantity?: number }[])
      .filter((c) => CAPABILITIES.includes(c.capability));
    const existing = await ctx.base44.asServiceRole.entities.VehicleCapability.filter({ vehicle_id: id });
    const existingByName = new Map((existing ?? []).map((c: { capability: string; id: string }) => [c.capability, c]));

    for (const cap of declared) {
      const row = existingByName.get(cap.capability);
      if (row) {
        await ctx.base44.asServiceRole.entities.VehicleCapability.update(row.id, {
          quantity: cap.quantity ?? 1,
          // Re-declaring resets verification: the equipment may have changed.
          verification_status: "self_reported",
          verified_by_email: "",
          verified_at: "",
        });
      } else {
        await ctx.base44.asServiceRole.entities.VehicleCapability.create({
          vehicle_id: id,
          driver_profile_id: profile.id,
          capability: cap.capability,
          quantity: cap.quantity ?? 1,
          verification_status: "self_reported",
        });
      }
    }

    await audit(ctx, {
      event_type: "vehicle.submit", action: vehicleId ? "update" : "create",
      subject_entity: "Vehicle", subject_id: id,
      metadata: { inspection_required: needsInspection, capabilities: declared.length },
    });

    return ok({
      vehicle_id: id,
      status: "pending_review",
      inspection_required: needsInspection,
      capabilities_recorded: declared.length,
      message: needsInspection
        ? `Saved. Because this vehicle is ${config.vehicle_inspection_age_years} years old or more, a coordinator will also need an annual licensed-mechanic inspection on file.`
        : "Saved. A coordinator will check it over before you can be matched.",
      note: "Anything you have listed as available counts only once a coordinator has verified it in person.",
    }, vehicleId ? 200 : 201);
  } catch (e) {
    console.error("manage_vehicle_failed", String(e));
    return serverError();
  }
}
