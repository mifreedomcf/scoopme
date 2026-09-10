/**
 * Staff verify a vehicle and, separately, each accommodation it claims.
 *
 * Verifying the vehicle does not verify its equipment. A wheelchair lift is
 * verified on its own, by someone who looked at it.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { computeEligibility } from "../../shared/eligibility.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only safety staff can verify vehicles.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const vehicleId = String(body.vehicle_id ?? "");

    const rows = await ctx.base44.asServiceRole.entities.Vehicle.filter({ id: vehicleId }, undefined, 1);
    const vehicle = (rows ?? [])[0];
    if (!vehicle) return notFound("That vehicle does not exist.");

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter(
      { id: vehicle.driver_profile_id }, undefined, 1,
    );
    const profile = (profiles ?? [])[0];
    if (!profile) return notFound("That driver profile does not exist.");
    if (profile.user_id === ctx.principal.userId) return forbidden("You cannot verify your own vehicle.");

    const today = todayISO();
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {};

    if (body.vehicle_status) {
      const status = String(body.vehicle_status);
      if (!["pending_review", "active", "retired", "suspended"].includes(status)) {
        return fail("invalid_status", "That is not a vehicle status.", 400);
      }
      if (status === "active" && vehicle.inspection_required) {
        const inspection = String(body.inspection_status ?? vehicle.inspection_status ?? "");
        const expires = String(body.inspection_expiration ?? vehicle.inspection_expiration ?? "");
        if (inspection !== "passed" || !expires || expires < today) {
          return fail(
            "inspection_required",
            "This vehicle is old enough to need a current licensed-mechanic inspection before it can be made active.",
            409,
          );
        }
      }
      patch.status = status;
    }
    if (body.inspection_status) patch.inspection_status = String(body.inspection_status);
    if (body.inspection_expiration) patch.inspection_expiration = String(body.inspection_expiration);
    if (body.photo_scan_status) patch.photo_scan_status = String(body.photo_scan_status);

    if (Object.keys(patch).length > 0) {
      await ctx.base44.asServiceRole.entities.Vehicle.update(vehicleId, patch);
    }

    // Each capability is verified individually, with its own reviewer.
    const decisions = (body.capability_decisions ?? []) as {
      capability_id: string; decision: string; expiration_date?: string;
    }[];
    const verifiedCapabilities: string[] = [];
    for (const d of decisions) {
      if (!["verified", "rejected", "expired"].includes(d.decision)) continue;
      const capRows = await ctx.base44.asServiceRole.entities.VehicleCapability.filter({ id: d.capability_id }, undefined, 1);
      const cap = (capRows ?? [])[0];
      if (!cap || cap.vehicle_id !== vehicleId) continue;
      await ctx.base44.asServiceRole.entities.VehicleCapability.update(d.capability_id, {
        verification_status: d.decision,
        verified_by_email: ctx.principal.email,
        verified_at: now,
        expiration_date: d.expiration_date,
      });
      if (d.decision === "verified") verifiedCapabilities.push(cap.capability);
    }

    const [credentials, vehicles] = await Promise.all([
      ctx.base44.asServiceRole.entities.DriverCredential.filter({ driver_profile_id: profile.id }),
      ctx.base44.asServiceRole.entities.Vehicle.filter({ driver_profile_id: profile.id }),
    ]);
    const eligibility = computeEligibility({
      approval_tier: profile.approval_tier,
      admin_suspended: profile.admin_suspended,
      on_incident_hold: profile.on_incident_hold,
      credentials: credentials ?? [],
      vehicles: vehicles ?? [],
      today,
    });
    await ctx.base44.asServiceRole.entities.DriverProfile.update(profile.id, {
      eligibility_status: eligibility.status,
      eligibility_reason_code: eligibility.reason_code,
      eligibility_blocking: eligibility.blocking,
      eligibility_computed_at: now,
    });

    await audit(ctx, {
      event_type: "vehicle.review", action: "approve",
      subject_entity: "Vehicle", subject_id: vehicleId,
      metadata: {
        fields: Object.keys(patch).join(","),
        capabilities_verified: verifiedCapabilities.join(","),
        resulting_eligibility: eligibility.status,
      },
    });

    return ok({
      vehicle_id: vehicleId,
      vehicle_status: patch.status ?? vehicle.status,
      capabilities_verified: verifiedCapabilities,
      driver_eligibility: eligibility.status,
      still_blocking: eligibility.blocking,
    });
  } catch (e) {
    console.error("review_vehicle_failed", String(e));
    return serverError();
  }
}
