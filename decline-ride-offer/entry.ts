/**
 * A driver declines an offer, so the dispatcher board reflects reality.
 *
 * Declining is recorded without a reason being required — pressure to justify
 * a decline is how volunteers stop declining and start not showing up.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "volunteer_driver")) return forbidden("Only volunteer drivers have ride offers.");

    const body = await readJson(req);
    const offerId = String(body?.offer_id ?? "");
    if (!offerId) return fail("missing_fields", "offer_id is required.", 400);

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter(
      { user_id: ctx.principal.userId }, undefined, 1,
    );
    const driver = (profiles ?? [])[0];
    if (!driver) return notFound("That offer does not exist.");

    const rows = await ctx.base44.asServiceRole.entities.RideOffer.filter({ id: offerId }, undefined, 1);
    const offer = (rows ?? [])[0];
    if (!offer || offer.driver_profile_id !== driver.id) return notFound("That offer does not exist.");
    if (offer.status !== "open") return ok({ offer_id: offerId, status: offer.status });

    const now = new Date().toISOString();
    await ctx.base44.asServiceRole.entities.RideOffer.update(offerId, {
      status: "declined", responded_at: now,
    });
    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: offer.ride_request_id, event_type: "offer_declined",
      actor_user_id: ctx.principal.userId, actor_role: "driver",
      reason_code: body?.reason_code ? String(body.reason_code) : "declined",
      occurred_at: now,
    });

    // If nobody is left holding an open offer, the dispatcher needs to know.
    const remaining = await ctx.base44.asServiceRole.entities.RideOffer.filter({
      ride_request_id: offer.ride_request_id, status: "open",
    });
    const noneLeft = (remaining ?? []).length === 0;
    if (noneLeft) {
      await ctx.base44.asServiceRole.entities.RideRequest.update(offer.ride_request_id, {
        status: "waitlisted", status_reason_code: "all_offers_declined",
      });
      await ctx.base44.asServiceRole.entities.RideEvent.create({
        ride_request_id: offer.ride_request_id, event_type: "transition",
        from_state: "offered", to_state: "waitlisted",
        actor_role: "system", reason_code: "all_offers_declined", occurred_at: now,
      });
    }

    await audit(ctx, {
      event_type: "ride.offer_declined", action: "update",
      subject_entity: "RideOffer", subject_id: offerId,
      metadata: { ride_request_id: offer.ride_request_id, offers_remaining: (remaining ?? []).length },
    });

    return ok({
      offer_id: offerId,
      status: "declined",
      ride_returned_to_waitlist: noneLeft,
      message: "Thanks for letting us know. It goes back to the coordinator.",
    });
  } catch (e) {
    console.error("decline_ride_offer_failed", String(e));
    return serverError();
  }
}
