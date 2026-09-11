/**
 * Child restraint rules. Pure module.
 *
 * DEFAULTS REQUIRE LEGAL CONFIRMATION. These encode Michigan's child passenger
 * safety requirements as amended effective 2 April 2025 (MCL 257.710d), but
 * nothing here has been confirmed by counsel. The `child_restraint` launch gate
 * exists precisely to have a person check this table against the statute before
 * a single child is ever carried. Every threshold is admin-configurable so a
 * change in law is a settings edit, not a code change.
 *
 * The rule this module actually enforces: a ride cannot be assigned unless the
 * correct restraint is VERIFIED as available in the assigned vehicle. A
 * driver's own word that they "have a booster somewhere" is not availability.
 */

export type RestraintType =
  | "rear_facing_car_seat"
  | "forward_facing_car_seat"
  | "booster_seat"
  | "seat_belt";

export interface RestraintPolicy {
  /** Below this age, rear-facing is required. */
  rear_facing_max_age: number;
  /** Below this age, a harnessed forward-facing seat is required. */
  forward_facing_max_age: number;
  /** Below this age, a booster is required unless the height exemption applies. */
  booster_max_age: number;
  /** At or above this height in inches, the booster requirement lifts. */
  booster_height_exemption_inches: number;
  /** Below this age, the child rides in the rear seat when one is available. */
  rear_seat_required_under_age: number;
  /** Below this age, a seat belt is required in any seating position. */
  seat_belt_required_under_age: number;
  /** Set true only once counsel has checked this table against the statute. */
  legally_reviewed: boolean;
  jurisdiction: string;
  source_note: string;
}

export const MICHIGAN_DEFAULT_POLICY: RestraintPolicy = {
  rear_facing_max_age: 2,
  forward_facing_max_age: 5,
  booster_max_age: 8,
  booster_height_exemption_inches: 57, // 4 feet 9 inches
  rear_seat_required_under_age: 13,
  seat_belt_required_under_age: 16,
  legally_reviewed: false,
  jurisdiction: "MI",
  source_note:
    "DRAFT — REQUIRES LEGAL REVIEW. Drafted from Michigan's child passenger safety requirements as amended effective 2 April 2025. Confirm against MCL 257.710d before use.",
};

export interface ChildMeasurements {
  /** Age in whole years on the date of travel. */
  age_years: number;
  /** Height in inches, if the guardian gave it. Optional by design: we collect
   *  the minimum needed to pick a restraint, and age alone is usually enough. */
  height_inches?: number;
  /** Manufacturer limits can require staying rear-facing past the legal age. */
  guardian_states_exceeds_rear_facing_limits?: boolean;
}

export interface RestraintRequirement {
  required: RestraintType;
  /** Rear seat required where the vehicle has one. */
  rear_seat_required: boolean;
  /** Plain-language reason, shown to the guardian, the dispatcher and the driver. */
  reason: string;
  /** True when the answer depends on a fact we do not have. */
  needs_more_information: boolean;
  policy_reviewed: boolean;
}

/**
 * Decide what a specific child needs on a specific trip.
 *
 * When information is missing the answer is the MORE protective restraint, plus
 * `needs_more_information`, never a guess in the permissive direction.
 */
export function requiredRestraint(
  child: ChildMeasurements,
  policy: RestraintPolicy = MICHIGAN_DEFAULT_POLICY,
): RestraintRequirement {
  const age = Number(child.age_years);
  const rearSeat = age < policy.rear_seat_required_under_age;
  const base = { rear_seat_required: rearSeat, policy_reviewed: policy.legally_reviewed };

  if (!Number.isFinite(age) || age < 0) {
    return {
      ...base,
      required: "rear_facing_car_seat",
      rear_seat_required: true,
      reason: "We do not have the child's age, so the most protective restraint applies until we do.",
      needs_more_information: true,
    };
  }

  if (child.guardian_states_exceeds_rear_facing_limits === false || age < policy.rear_facing_max_age) {
    return {
      ...base,
      required: "rear_facing_car_seat",
      reason: `Under ${policy.rear_facing_max_age}, or still within the seat manufacturer's rear-facing limits.`,
      needs_more_information: false,
    };
  }

  if (age < policy.forward_facing_max_age) {
    return {
      ...base,
      required: "forward_facing_car_seat",
      reason: `Between ${policy.rear_facing_max_age} and ${policy.forward_facing_max_age}, a harnessed forward-facing seat is required.`,
      needs_more_information: false,
    };
  }

  if (age < policy.booster_max_age) {
    const tallEnough = child.height_inches !== undefined &&
      child.height_inches >= policy.booster_height_exemption_inches;
    if (tallEnough) {
      return {
        ...base,
        required: "seat_belt",
        reason: `At ${policy.booster_height_exemption_inches} inches or taller, a lap-and-shoulder belt is permitted.`,
        needs_more_information: false,
      };
    }
    return {
      ...base,
      required: "booster_seat",
      reason: child.height_inches === undefined
        ? `Under ${policy.booster_max_age}. Without a height we assume a booster is needed.`
        : `Under ${policy.booster_max_age} and under ${policy.booster_height_exemption_inches} inches.`,
      needs_more_information: child.height_inches === undefined,
    };
  }

  return {
    ...base,
    required: "seat_belt",
    reason: `${policy.booster_max_age} or older. A lap-and-shoulder belt is permitted${rearSeat ? ", in the rear seat" : ""}.`,
    needs_more_information: false,
  };
}

/** Restraint requirement mapped to the verified vehicle capability that satisfies it. */
export const RESTRAINT_TO_CAPABILITY: Record<RestraintType, string | null> = {
  rear_facing_car_seat: "rear_facing_car_seat",
  forward_facing_car_seat: "forward_facing_car_seat",
  booster_seat: "booster_seat",
  seat_belt: null, // every vehicle has belts
};

export interface CapabilitySnapshot {
  capability: string;
  quantity: number;
  verification_status: string;
  expiration_date?: string;
}

export interface RestraintCheck {
  satisfied: boolean;
  code: string;
  message: string;
  required: RestraintType;
}

/**
 * Can this vehicle actually carry this child, legally and physically?
 *
 * Only a VERIFIED, unexpired capability counts. This is the check that stands
 * between a child and a car with no seat in it.
 */
export function vehicleSatisfiesRestraint(
  requirement: RestraintRequirement,
  capabilities: CapabilitySnapshot[],
  today: string,
  vehicleHasRearSeat = true,
): RestraintCheck {
  const needed = RESTRAINT_TO_CAPABILITY[requirement.required];

  if (requirement.rear_seat_required && !vehicleHasRearSeat) {
    return {
      satisfied: false,
      code: "no_rear_seat",
      message: "This child must ride in the rear seat and this vehicle does not have one.",
      required: requirement.required,
    };
  }

  if (needed === null) {
    return {
      satisfied: true,
      code: "seat_belt_sufficient",
      message: "A lap-and-shoulder belt is sufficient for this child.",
      required: requirement.required,
    };
  }

  const match = capabilities.find((c) => c.capability === needed);
  if (!match) {
    return {
      satisfied: false,
      code: "restraint_not_available",
      message: `No ${needed.replace(/_/g, " ")} is recorded for this vehicle.`,
      required: requirement.required,
    };
  }
  if (match.verification_status !== "verified") {
    return {
      satisfied: false,
      code: "restraint_not_verified",
      message: `The ${needed.replace(/_/g, " ")} for this vehicle has not been checked by a coordinator.`,
      required: requirement.required,
    };
  }
  if (match.expiration_date && match.expiration_date < today) {
    return {
      satisfied: false,
      code: "restraint_expired",
      message: `The ${needed.replace(/_/g, " ")} check has expired.`,
      required: requirement.required,
    };
  }
  if (match.quantity < 1) {
    return {
      satisfied: false,
      code: "restraint_quantity",
      message: `Not enough of the right restraint in this vehicle.`,
      required: requirement.required,
    };
  }

  return {
    satisfied: true,
    code: "restraint_verified",
    message: `A verified ${needed.replace(/_/g, " ")} is available.`,
    required: requirement.required,
  };
}

/** Build the live policy from admin settings, falling back to the defaults. */
export function policyFromConfig(config: Record<string, unknown>): RestraintPolicy {
  const num = (key: string, fallback: number) => {
    const v = Number(config[key]);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    rear_facing_max_age: num("restraint_rear_facing_max_age", MICHIGAN_DEFAULT_POLICY.rear_facing_max_age),
    forward_facing_max_age: num("restraint_forward_facing_max_age", MICHIGAN_DEFAULT_POLICY.forward_facing_max_age),
    booster_max_age: num("restraint_booster_max_age", MICHIGAN_DEFAULT_POLICY.booster_max_age),
    booster_height_exemption_inches: num("restraint_booster_height_exemption_inches", MICHIGAN_DEFAULT_POLICY.booster_height_exemption_inches),
    rear_seat_required_under_age: num("restraint_rear_seat_required_under_age", MICHIGAN_DEFAULT_POLICY.rear_seat_required_under_age),
    seat_belt_required_under_age: num("restraint_seat_belt_required_under_age", MICHIGAN_DEFAULT_POLICY.seat_belt_required_under_age),
    // Never inferred. A person has to set this deliberately.
    legally_reviewed: config.restraint_policy_reviewed === true,
    jurisdiction: String(config.restraint_jurisdiction ?? "MI"),
    source_note: MICHIGAN_DEFAULT_POLICY.source_note,
  };
}
