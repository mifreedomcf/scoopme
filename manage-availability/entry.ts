/**
 * A driver adds or cancels a window in which they are willing to volunteer.
 *
 * Cancelling a window that already has a claimed ride inside it is refused —
 * the ride is cancelled explicitly through the ride flow, so a rider is never
 * quietly stranded by a calendar edit.
 */
import { conflict, fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";

const MAX_WINDOW_HOURS = 14;

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

    const action = String(body.action ?? "add");

    if (action === "cancel") {
      const windowId = String(body.availability_id ?? "");
      const rows = await ctx.base44.asServiceRole.entities.DriverAvailability.filter({ id: windowId }, undefined, 1);
      const window = (rows ?? [])[0];
      if (!window || window.driver_profile_id !== profile.id) return notFound("That window does not exist.");

      const assignments = await ctx.base44.asServiceRole.entities.RideAssignment.filter({
        driver_profile_id: profile.id, is_active: true,
      });
      for (const a of assignments ?? []) {
        const r = await ctx.base44.asServiceRole.entities.RideRequest.filter({ id: a.ride_request_id }, undefined, 1);
        const ride = (r ?? [])[0];
        if (!ride?.requested_pickup_at) continue;
        if (ride.requested_pickup_at >= window.starts_at && ride.requested_pickup_at <= window.ends_at) {
          return conflict(
            "window_has_committed_ride",
            "You have a ride booked in this window. Release that ride first so a coordinator can find someone else.",
          );
        }
      }

      await ctx.base44.asServiceRole.entities.DriverAvailability.update(windowId, { status: "canceled" });
      await audit(ctx, {
        event_type: "availability.cancel", action: "update",
        subject_entity: "DriverAvailability", subject_id: windowId,
      });
      return ok({ availability_id: windowId, status: "canceled" });
    }

    const startsAt = String(body.starts_at ?? "");
    const endsAt = String(body.ends_at ?? "");
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    const errors: { field: string; code: string; message: string }[] = [];

    if (Number.isNaN(start.getTime())) errors.push({ field: "starts_at", code: "invalid_date", message: "Choose a start time." });
    if (Number.isNaN(end.getTime())) errors.push({ field: "ends_at", code: "invalid_date", message: "Choose an end time." });
    if (errors.length === 0) {
      if (end <= start) errors.push({ field: "ends_at", code: "end_before_start", message: "The end time has to be after the start." });
      const hours = (end.getTime() - start.getTime()) / 3_600_000;
      if (hours > MAX_WINDOW_HOURS) {
        errors.push({
          field: "ends_at", code: "window_too_long",
          message: `Keep a window to ${MAX_WINDOW_HOURS} hours or less. Long stretches behind the wheel are not safe.`,
        });
      }
      if (end.getTime() < Date.now()) {
        errors.push({ field: "ends_at", code: "in_the_past", message: "That window has already passed." });
      }
    }
    if (errors.length > 0) return fail("validation_failed", "Check these times.", 400, errors);

    const existing = await ctx.base44.asServiceRole.entities.DriverAvailability.filter({
      driver_profile_id: profile.id, status: "active",
    });
    const overlapping = (existing ?? []).some(
      (w: { starts_at: string; ends_at: string }) => startsAt < w.ends_at && w.starts_at < endsAt,
    );
    if (overlapping) return conflict("overlapping_window", "That overlaps a window you already have.");

    const created = await ctx.base44.asServiceRole.entities.DriverAvailability.create({
      driver_profile_id: profile.id,
      starts_at: startsAt,
      ends_at: endsAt,
      recurrence: body.recurrence ? String(body.recurrence) : "none",
      weekday: body.weekday !== undefined ? Number(body.weekday) : undefined,
      status: "active",
      notes: body.notes ? String(body.notes) : undefined,
    });

    await audit(ctx, {
      event_type: "availability.add", action: "create",
      subject_entity: "DriverAvailability", subject_id: created.id,
    });

    return ok({ availability_id: created.id, status: "active" }, 201);
  } catch (e) {
    console.error("manage_availability_failed", String(e));
    return serverError();
  }
}
