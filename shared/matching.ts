/**
 * Deterministic, explainable driver matching. Pure module.
 *
 * No model is involved. Every filter is a hard rule with a stated reason, so a
 * dispatcher can always answer "why was this driver eligible?".
 */
import { distanceMiles, LatLng } from "./geo.ts";

export interface CredentialSnapshot {
  credential_type: string;
  required_for: "adult_transport" | "minor_transport" | "accommodation_only";
  status: string;
  expiration_date?: string;
}

export interface CapabilitySnapshot {
  capability: string;
  quantity: number;
  verification_status: string;
  expiration_date?: string;
}

export interface AvailabilityWindow {
  starts_at: string;
  ends_at: string;
  status: string;
}

export interface DriverSnapshot {
  driver_profile_id: string;
  approval_tier: "none" | "adult_transport_approved" | "minor_transport_approved";
  eligibility_status: string;
  languages: string[];
  accepts_service_animals: boolean;
  max_travel_miles: number;
  home_point?: LatLng;
  credentials: CredentialSnapshot[];
  capabilities: CapabilitySnapshot[];
  availability: AvailabilityWindow[];
  /** Rides already claimed by this driver, used for conflict detection. */
  bookedWindows: { starts_at: string; ends_at: string }[];
  vehicleSeatingCapacity: number;
  vehicleStatus: string;
  vehicleInspectionOk: boolean;
}

export interface RideMatchInput {
  riderKind: "adult" | "minor";
  passengerCount: number;
  windowStart: string;
  windowEnd: string;
  languagePreference?: string;
  serviceAnimal: boolean;
  needs: { need: string; detail?: string; quantity: number; is_hard_requirement: boolean }[];
  pickupPoint?: LatLng;
  maxVolunteerTravelMiles: number;
}

/** Credentials that must be verified and unexpired for any assignment. */
export const REQUIRED_ADULT_CREDENTIALS = [
  "drivers_license",
  "vehicle_registration",
  "auto_insurance",
  "mvr_check",
  "criminal_background_check",
  "sex_offender_registry_check",
];

/** Additional credentials required before a driver may transport a minor. */
export const REQUIRED_MINOR_CREDENTIALS = [
  "fingerprinting",
  "child_abuse_neglect_registry",
];

/** Ride need -> the verified vehicle capability that satisfies it. */
export const NEED_TO_CAPABILITY: Record<string, string> = {
  wheelchair_lift: "wheelchair_lift",
  wheelchair_securement: "wheelchair_securement",
  booster_seat: "booster_seat",
  forward_facing_car_seat: "forward_facing_car_seat",
  rear_facing_car_seat: "rear_facing_car_seat",
  service_animal: "service_animal_ok",
  extra_space: "extra_passenger_space",
};

/** Ride need -> the driver credential that satisfies it. */
export const NEED_TO_CREDENTIAL: Record<string, string> = {
  cdl_required: "cdl",
  cpr_certified: "cpr",
  first_aid_certified: "first_aid",
};

export interface MatchVerdict {
  eligible: boolean;
  /** Why this driver failed. Empty when eligible. */
  failures: string[];
  /** Which filters this driver passed. Stored on the offer for explainability. */
  passed: string[];
}

function credentialOk(c: CredentialSnapshot | undefined, today: string): boolean {
  if (!c) return false;
  if (c.status !== "verified") return false;
  if (c.expiration_date && c.expiration_date < today) return false;
  return true;
}

function capabilityOk(c: CapabilitySnapshot | undefined, today: string, quantity: number): boolean {
  if (!c) return false;
  if (c.verification_status !== "verified") return false;
  if (c.expiration_date && c.expiration_date < today) return false;
  return c.quantity >= quantity;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Evaluate one driver against one ride. Order matters only for readability;
 * every filter is applied and every failure is reported.
 */
export function evaluateDriver(
  driver: DriverSnapshot,
  ride: RideMatchInput,
  today: string,
): MatchVerdict {
  const failures: string[] = [];
  const passed: string[] = [];

  if (driver.eligibility_status !== "eligible") {
    failures.push(`driver_not_eligible:${driver.eligibility_status}`);
  } else {
    passed.push("driver_status_eligible");
  }

  // Approval tier. A general adult approval never covers a minor ride.
  if (ride.riderKind === "minor") {
    if (driver.approval_tier !== "minor_transport_approved") {
      failures.push("missing_minor_transport_tier");
    } else {
      passed.push("minor_transport_tier_verified");
    }
  } else if (driver.approval_tier === "none") {
    failures.push("driver_not_approved");
  } else {
    passed.push("adult_transport_tier_verified");
  }

  // Required credentials, verified and unexpired.
  const byType = new Map(driver.credentials.map((c) => [c.credential_type, c]));
  const required = ride.riderKind === "minor"
    ? [...REQUIRED_ADULT_CREDENTIALS, ...REQUIRED_MINOR_CREDENTIALS]
    : REQUIRED_ADULT_CREDENTIALS;
  for (const type of required) {
    if (!credentialOk(byType.get(type), today)) {
      failures.push(`credential_missing_or_expired:${type}`);
    }
  }
  if (required.every((t) => credentialOk(byType.get(t), today))) {
    passed.push("required_credentials_current");
  }

  // Vehicle.
  if (driver.vehicleStatus !== "active") {
    failures.push("vehicle_not_active");
  } else if (!driver.vehicleInspectionOk) {
    failures.push("vehicle_inspection_not_current");
  } else if (driver.vehicleSeatingCapacity < ride.passengerCount) {
    failures.push("insufficient_seating_capacity");
  } else {
    passed.push("vehicle_active_and_sized");
  }

  // Availability, with conflict detection.
  const availableWindow = driver.availability.some(
    (w) => w.status === "active" && w.starts_at <= ride.windowStart && w.ends_at >= ride.windowEnd,
  );
  if (!availableWindow) {
    failures.push("no_availability_window");
  } else {
    passed.push("availability_window_covers_ride");
  }
  const conflict = driver.bookedWindows.some((b) =>
    overlaps(ride.windowStart, ride.windowEnd, b.starts_at, b.ends_at),
  );
  if (conflict) {
    failures.push("schedule_conflict");
  } else {
    passed.push("no_schedule_conflict");
  }

  // Accommodations. Only verified capabilities count.
  const capByName = new Map(driver.capabilities.map((c) => [c.capability, c]));
  for (const need of ride.needs) {
    if (!need.is_hard_requirement) continue;

    const capName = NEED_TO_CAPABILITY[need.need];
    if (capName) {
      if (!capabilityOk(capByName.get(capName), today, need.quantity)) {
        failures.push(`unverified_capability:${need.need}`);
      } else {
        passed.push(`capability_verified:${need.need}`);
      }
      continue;
    }
    const credName = NEED_TO_CREDENTIAL[need.need];
    if (credName) {
      if (!credentialOk(byType.get(credName), today)) {
        failures.push(`unverified_credential:${need.need}`);
      } else {
        passed.push(`credential_verified:${need.need}`);
      }
      continue;
    }
    if (need.need === "language") {
      const wanted = need.detail ?? ride.languagePreference ?? "en";
      if (!driver.languages.includes(wanted)) {
        failures.push(`language_not_supported:${wanted}`);
      } else {
        passed.push(`language_supported:${wanted}`);
      }
    }
  }

  if (ride.serviceAnimal && !driver.accepts_service_animals) {
    failures.push("service_animal_not_accepted");
  } else if (ride.serviceAnimal) {
    passed.push("service_animal_accepted");
  }

  // Travel distance.
  if (ride.pickupPoint && driver.home_point) {
    const miles = distanceMiles(driver.home_point, ride.pickupPoint);
    const cap = Math.min(driver.max_travel_miles, ride.maxVolunteerTravelMiles);
    if (miles > cap) {
      failures.push("beyond_max_volunteer_travel_distance");
    } else {
      passed.push("within_travel_distance");
    }
  }

  return { eligible: failures.length === 0, failures, passed };
}

/** Rank eligible drivers deterministically: nearest first, then stable by id. */
export function rankEligibleDrivers(
  drivers: DriverSnapshot[],
  ride: RideMatchInput,
  today: string,
): { driver: DriverSnapshot; verdict: MatchVerdict; distanceMiles: number | null }[] {
  return drivers
    .map((driver) => ({
      driver,
      verdict: evaluateDriver(driver, ride, today),
      distanceMiles:
        ride.pickupPoint && driver.home_point
          ? distanceMiles(driver.home_point, ride.pickupPoint)
          : null,
    }))
    .filter((r) => r.verdict.eligible)
    .sort((a, b) => {
      const da = a.distanceMiles ?? Number.MAX_SAFE_INTEGER;
      const db = b.distanceMiles ?? Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      return a.driver.driver_profile_id.localeCompare(b.driver.driver_profile_id);
    });
}
