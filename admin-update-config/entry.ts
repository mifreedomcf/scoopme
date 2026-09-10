/**
 * Admin configuration writes.
 *
 * SystemConfig denies all client writes, so this is the only way to change a
 * flag. Every change is gate-checked, floor-checked, and audited. An override,
 * where permitted at all, needs typed justification plus re-authentication.
 */
import { fail, forbidden, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { evaluateFlagChange } from "../../shared/flags.ts";

/** Fields an admin may set. Anything else in the payload is ignored. */
const EDITABLE = [
  "operator_legal_name", "brand_name", "brand_tagline", "brand_logo_url",
  "brand_color_primary", "brand_color_accent", "support_email", "support_phone", "safety_phone",
  "pilot_mode", "service_area_label", "service_area_city", "service_area_state",
  "allowed_destination_zip_codes", "allowed_pickup_zip_codes",
  "adult_rides_enabled", "minor_rides_enabled", "same_day_rides_enabled",
  "direct_driver_tips_enabled", "platform_donations_enabled",
  "organization_in_kind_contributions_enabled", "live_location_enabled", "ride_fulfillment_enabled",
  "background_check_provider_mode", "geocoder_provider_mode",
  "minimum_request_lead_hours", "minimum_driver_age", "minimum_minor_transport_driver_age",
  "driver_tip_annual_cap_cents", "max_volunteer_travel_miles", "vehicle_inspection_age_years",
  "ride_request_rate_limit_per_day", "legal_content_approved",
];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "platform_admin")) return forbidden("Only platform administrators can change settings.");

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const changes = (body.changes ?? {}) as Record<string, unknown>;
    const overrideJustification = body.override_justification ? String(body.override_justification) : undefined;
    const reauthenticated = body.reauthenticated === true;

    const current = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const today = todayISO();

    const applied: Record<string, unknown> = {};
    const rejected: { field: string; code: string; message: string }[] = [];
    const overridesUsed: string[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (!EDITABLE.includes(key)) {
        rejected.push({ field: key, code: "not_editable", message: "That setting cannot be changed here." });
        continue;
      }
      const verdict = evaluateFlagChange(
        { flag: key, value, overrideJustification, reauthenticated },
        current, gates, today,
      );
      if (!verdict.allowed) {
        rejected.push({ field: key, code: verdict.code, message: verdict.message });
        await audit(ctx, {
          event_type: "config.update", action: "update", outcome: "denied",
          subject_entity: "SystemConfig", reason_code: verdict.code, metadata: { field: key },
        });
        continue;
      }
      if (verdict.usedOverride) {
        overridesUsed.push(key);
        await audit(ctx, {
          event_type: "config.override", action: "override", subject_entity: "SystemConfig",
          reason_code: "emergency_override", justification: overrideJustification,
          metadata: { field: key, detail: verdict.message },
        });
      }
      applied[key] = value;
    }

    if (Object.keys(applied).length === 0) {
      return fail("no_changes_applied", "None of those changes could be applied.", 409, rejected);
    }

    const rows = await ctx.base44.asServiceRole.entities.SystemConfig.filter({ config_key: "active" }, undefined, 1);
    const existing = (rows ?? [])[0];
    applied.config_version = Number(current.config_version ?? 1) + 1;

    if (existing) {
      await ctx.base44.asServiceRole.entities.SystemConfig.update(existing.id, applied);
    } else {
      await ctx.base44.asServiceRole.entities.SystemConfig.create({ config_key: "active", ...applied });
    }

    await audit(ctx, {
      event_type: "config.update", action: "update", subject_entity: "SystemConfig",
      metadata: { fields: Object.keys(applied).join(","), overrides: overridesUsed.join(",") },
    });

    return ok({
      applied: Object.keys(applied),
      rejected,
      overrides_used: overridesUsed,
      config_version: applied.config_version,
    });
  } catch (e) {
    console.error("admin_update_config_failed", String(e));
    return serverError();
  }
}
