/**
 * Open offers for the signed-in driver, minimized.
 *
 * This never returns an address, a coordinate, a phone number, or a
 * verification code, whatever the caller asks for.
 */
import { forbidden, ok, serverError, unauthorized } from "../../shared/http.ts";
import { buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "volunteer_driver")) return forbidden("Only approved volunteer drivers can see ride offers.");

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter({ user_id: ctx.principal.userId }, undefined, 1);
    const driver = (profiles ?? [])[0];
    if (!driver) return ok({ offers: [], eligibility_status: "no_profile" });

    // An ineligible or expired-credential driver sees nothing at all.
    if (driver.eligibility_status !== "eligible") {
      return ok({
        offers: [],
        eligibility_status: driver.eligibility_status,
        message: "Ride offers are paused for your account. Check your credentials page for what is missing or expired.",
      });
    }

    const offers = await ctx.base44.asServiceRole.entities.RideOffer.filter(
      { driver_profile_id: driver.id, status: "open" }, "window_start", 100,
    );

    const today = todayISO();
    const visible = (offers ?? [])
      .filter((o: Record<string, string>) => !o.expires_at || o.expires_at >= new Date().toISOString())
      .map((o: Record<string, unknown>) => ({
        offer_id: o.id,
        ride_request_id: o.ride_request_id,
        pickup_area_label: o.pickup_area_label,
        destination_area_label: o.destination_area_label,
        resource_category: o.resource_category,
        window_start: o.window_start,
        window_end: o.window_end,
        passenger_count: o.passenger_count,
        required_capabilities: o.required_capabilities,
        approx_distance_miles: o.approx_distance_miles,
        why_you_match: o.match_explanation,
      }));

    return ok({ offers: visible, eligibility_status: "eligible", as_of: today });
  } catch (e) {
    console.error("list_driver_offers_failed", String(e));
    return serverError();
  }
}
