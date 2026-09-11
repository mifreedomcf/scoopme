/**
 * Public configuration projection.
 *
 * Returns branding, service-area copy, and the *effective* feature flags the UI
 * needs. It deliberately never returns provider keys, gate evidence links,
 * reviewer identities, or any numeric threshold that is not needed to render.
 */
import { ok, serverError } from "../../shared/http.ts";
import { buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { canFulfillRides } from "../../shared/flags.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const fulfillment = canFulfillRides(config, gates, todayISO());

    return ok({
      brand: {
        name: config.brand_name,
        tagline: config.brand_tagline,
        logo_url: config.brand_logo_url ?? null,
        color_primary: config.brand_color_primary,
        color_accent: config.brand_color_accent,
      },
      operator_legal_name: config.operator_legal_name,
      support: {
        email: config.support_email || null,
        phone: config.support_phone || null,
        safety_phone: config.safety_phone || null,
      },
      pilot: {
        pilot_mode: config.pilot_mode,
        service_area_label: config.service_area_label,
        allowed_destination_zip_codes: config.allowed_destination_zip_codes,
        minimum_request_lead_hours: config.minimum_request_lead_hours,
      },
      flags: {
        adult_rides_enabled: config.adult_rides_enabled,
        minor_rides_enabled: config.minor_rides_enabled,
        same_day_rides_enabled: config.same_day_rides_enabled,
        direct_driver_tips_enabled: config.direct_driver_tips_enabled,
        platform_donations_enabled: config.platform_donations_enabled,
        organization_in_kind_contributions_enabled: config.organization_in_kind_contributions_enabled,
        live_location_enabled: config.live_location_enabled,
        ride_fulfillment_enabled: fulfillment.allowed,
      },
      fulfillment_status: { allowed: fulfillment.allowed, code: fulfillment.code, message: fulfillment.message },
      legal_content_approved: config.legal_content_approved,
      // Riders are never charged. Stated as data so the UI cannot drift from it.
      pricing: { rider_fare_cents: 0, booking_fee_cents: 0, required_contribution: false },
      roles: ctx.principal
        ? { roles: ctx.principal.roles, suspended: ctx.principal.suspended, email: ctx.principal.email }
        : null,
    });
  } catch {
    return serverError();
  }
}
