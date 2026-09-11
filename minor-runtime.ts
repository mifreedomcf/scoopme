/**
 * Assembles the snapshot the minor gate needs, from live records.
 *
 * Kept separate from `minor-gate.ts` so the decision stays pure and testable
 * and only this thin layer touches the database.
 */
import type { Ctx } from "./runtime.ts";
import { checkGatesForFlag, type GateRecord } from "./flags.ts";
import { checkMinorRide, type MinorGateVerdict } from "./minor-gate.ts";
import { policyFromConfig } from "./restraints.ts";
import type { SystemConfigShape } from "./constants.ts";

function ageYears(dob: string, on: string): number {
  const birth = new Date(`${dob}T00:00:00Z`);
  const when = new Date(`${on}T00:00:00Z`);
  let age = when.getUTCFullYear() - birth.getUTCFullYear();
  const m = when.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && when.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

/**
 * Evaluate a minor ride against every requirement. Returns `allowed: false`
 * with a full blocking list; callers refuse rather than proceed.
 *
 * Fails closed: if anything cannot be read, the ride is blocked.
 */
export async function evaluateMinorRide(
  ctx: Ctx,
  ride: Record<string, unknown>,
  config: SystemConfigShape,
  gates: GateRecord[],
  today: string,
): Promise<MinorGateVerdict> {
  const sr = ctx.base44.asServiceRole.entities;
  const dependentId = String(ride.dependent_profile_id ?? "");

  if (!dependentId) {
    return {
      allowed: false,
      blocking: [{ code: "no_dependent_profile", message: "This ride is marked as being for a child but has no child profile attached." }],
      satisfied: [],
    };
  }

  try {
    const [children, relationships, consents] = await Promise.all([
      sr.DependentProfile.filter({ id: dependentId }, undefined, 1),
      sr.GuardianRelationship.filter({ dependent_profile_id: dependentId, status: "verified" }, "-verified_at", 5),
      sr.ConsentRecord.filter({ dependent_profile_id: dependentId }, "-created_date", 50),
    ]);

    const child = (children ?? [])[0];
    if (!child) {
      return {
        allowed: false,
        blocking: [{ code: "child_profile_missing", message: "The child's profile could not be found." }],
        satisfied: [],
      };
    }
    const relationship = (relationships ?? [])[0] ?? null;

    const assignments = await sr.RideAssignment.filter({ ride_request_id: String(ride.id), is_active: true });
    const assignment = (assignments ?? [])[0] ?? null;

    let driver: { approval_tier: string; eligibility_status: string } | null = null;
    let capabilities: { capability: string; quantity: number; verification_status: string; expiration_date?: string }[] = [];
    let vehicleHasRearSeat = true;

    if (assignment) {
      const drivers = await sr.DriverProfile.filter({ id: assignment.driver_profile_id }, undefined, 1);
      const d = (drivers ?? [])[0];
      if (d) driver = { approval_tier: String(d.approval_tier), eligibility_status: String(d.eligibility_status) };
      if (assignment.vehicle_id) {
        capabilities = (await sr.VehicleCapability.filter({ vehicle_id: assignment.vehicle_id })) ?? [];
        const vehicles = await sr.Vehicle.filter({ id: assignment.vehicle_id }, undefined, 1);
        const v = (vehicles ?? [])[0];
        vehicleHasRearSeat = !v || Number(v.seating_capacity ?? 4) > 2;
      }
    }

    const docs = await sr.LegalDocument.filter(
      { document_key: "guardian_agreement_minor_authorization", published: true }, "-effective_at", 1,
    );
    const currentVersion = (docs ?? [])[0]?.version ?? "";

    return checkMinorRide({
      minorRidesEnabled: config.minor_rides_enabled === true,
      gatesSatisfied: checkGatesForFlag("minor_rides_enabled", gates, today).satisfied,
      authority: relationship
        ? {
            guardian_user_id: relationship.guardian_user_id,
            dependent_profile_id: relationship.dependent_profile_id,
            authority_type: relationship.authority_type,
            status: relationship.status,
            verified_by_email: relationship.verified_by_email,
            verified_at: relationship.verified_at,
            expires_on: relationship.expires_on,
          }
        : null,
      dependentProfileId: dependentId,
      guardianUserId: relationship?.guardian_user_id ?? "",
      consentRecords: (consents ?? []) as never,
      consentContext: {
        dependentProfileId: dependentId,
        rideRequestId: String(ride.id),
        currentDocumentVersion: currentVersion,
        standingConsentApproved: config.standing_minor_consent_approved === true,
        today,
        now: new Date().toISOString(),
      },
      child: {
        age_years: ageYears(String(child.date_of_birth), today),
        height_inches: child.height_inches !== undefined ? Number(child.height_inches) : undefined,
        guardian_states_exceeds_rear_facing_limits: child.guardian_states_exceeds_rear_facing_limits,
      },
      restraintPolicy: policyFromConfig(config as unknown as Record<string, unknown>),
      driver,
      vehicleCapabilities: capabilities,
      vehicleHasRearSeat,
      today,
    });
  } catch (e) {
    console.error("evaluate_minor_ride_failed", String(e));
    // Fail closed. If we cannot confirm every requirement, the child does not travel.
    return {
      allowed: false,
      blocking: [{ code: "minor_checks_unavailable", message: "We could not confirm every safety requirement, so this ride cannot go ahead." }],
      satisfied: [],
    };
  }
}
