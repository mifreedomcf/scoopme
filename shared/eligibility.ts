/**
 * Driver eligibility. Pure module.
 *
 * Eligibility is always DERIVED — from credential state, vehicle state, and
 * administrative holds. It is never a value a driver sets, and never a value
 * that lingers after the thing that justified it expires. `credential-expiry-sweep`
 * recomputes it daily; `claim-ride` recomputes it again at the moment of claim,
 * so a document that lapses between the two still blocks the ride.
 */
import { REQUIRED_ADULT_CREDENTIALS, REQUIRED_MINOR_CREDENTIALS, type CredentialSnapshot } from "./matching.ts";

export type EligibilityStatus =
  | "ineligible"
  | "eligible"
  | "suspended_expired_credential"
  | "suspended_admin"
  | "on_incident_hold";

export type ApprovalTier = "none" | "adult_transport_approved" | "minor_transport_approved";

export interface VehicleSnapshot {
  id: string;
  status: string;
  inspection_required?: boolean;
  inspection_status?: string;
  inspection_expiration?: string;
  seating_capacity?: number;
}

export interface EligibilityInput {
  approval_tier: ApprovalTier;
  /** Set by staff. Wins over everything: an admin suspension is not recomputed away. */
  admin_suspended?: boolean;
  on_incident_hold?: boolean;
  credentials: CredentialSnapshot[];
  vehicles: VehicleSnapshot[];
  today: string;
}

export interface EligibilityResult {
  status: EligibilityStatus;
  reason_code: string;
  /** Credential types that are missing, unverified, or expired. */
  blocking: string[];
  /** Credentials expiring within the notice window, for advance warning. */
  expiring_soon: { credential_type: string; expiration_date: string }[];
}

function isCurrent(c: CredentialSnapshot | undefined, today: string): boolean {
  if (!c) return false;
  if (c.status !== "verified") return false;
  if (c.expiration_date && c.expiration_date < today) return false;
  return true;
}

/** Days before expiry that a driver and safety staff are warned. */
export const EXPIRY_NOTICE_DAYS = 30;

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The single definition of whether a driver may be offered or assigned a ride.
 */
export function computeEligibility(input: EligibilityInput): EligibilityResult {
  const { today } = input;
  const byType = new Map(input.credentials.map((c) => [c.credential_type, c]));

  const required = input.approval_tier === "minor_transport_approved"
    ? [...REQUIRED_ADULT_CREDENTIALS, ...REQUIRED_MINOR_CREDENTIALS]
    : REQUIRED_ADULT_CREDENTIALS;

  const blocking = required.filter((type) => !isCurrent(byType.get(type), today));

  const noticeCutoff = addDays(today, EXPIRY_NOTICE_DAYS);
  const expiring_soon = input.credentials
    .filter((c) =>
      c.status === "verified" &&
      c.expiration_date !== undefined &&
      c.expiration_date >= today &&
      c.expiration_date <= noticeCutoff)
    .map((c) => ({ credential_type: c.credential_type, expiration_date: c.expiration_date as string }))
    .sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));

  // Administrative states are decided by people and are never recomputed away.
  if (input.on_incident_hold) {
    return { status: "on_incident_hold", reason_code: "incident_hold_active", blocking, expiring_soon };
  }
  if (input.admin_suspended) {
    return { status: "suspended_admin", reason_code: "suspended_by_staff", blocking, expiring_soon };
  }
  if (input.approval_tier === "none") {
    return { status: "ineligible", reason_code: "not_approved", blocking, expiring_soon };
  }

  // A credential that has been verified and then lapsed is a suspension, not a
  // fresh ineligibility — the distinction matters to the driver and to the
  // dispatcher looking at the board.
  if (blocking.length > 0) {
    const lapsed = blocking.some((type) => {
      const c = byType.get(type);
      return c?.status === "verified" || c?.status === "expired";
    });
    return {
      status: lapsed ? "suspended_expired_credential" : "ineligible",
      reason_code: lapsed ? "credential_expired" : "credentials_incomplete",
      blocking,
      expiring_soon,
    };
  }

  const activeVehicle = input.vehicles.find((v) => v.status === "active");
  if (!activeVehicle) {
    return { status: "ineligible", reason_code: "no_active_vehicle", blocking: ["vehicle"], expiring_soon };
  }
  if (activeVehicle.inspection_required) {
    const inspectionCurrent =
      activeVehicle.inspection_status === "passed" &&
      (!activeVehicle.inspection_expiration || activeVehicle.inspection_expiration >= today);
    if (!inspectionCurrent) {
      return {
        status: "suspended_expired_credential",
        reason_code: "vehicle_inspection_not_current",
        blocking: ["vehicle_inspection"],
        expiring_soon,
      };
    }
  }

  return { status: "eligible", reason_code: "approved_credentials_current", blocking: [], expiring_soon };
}

/** A vehicle this old or older needs annual licensed-mechanic inspection tracking. */
export function inspectionRequired(vehicleYear: number, thresholdYears: number, today: string): boolean {
  const currentYear = Number(today.slice(0, 4));
  return currentYear - vehicleYear >= thresholdYears;
}
