/**
 * The single gate every minor ride has to pass. Pure module.
 *
 * Five things must all hold before a child is carried, and this returns the
 * complete list of what is missing rather than the first failure, so a
 * dispatcher sees the whole picture instead of fixing one thing at a time:
 *
 *   1. the feature flag is on and its launch gates are complete
 *   2. a verified guardian authority exists for this child
 *   3. current, correctly scoped consent covers this exact trip
 *   4. the driver holds the minor_transport tier and its extra checks
 *   5. the assigned vehicle has the legally required restraint, verified
 *
 * Called before a minor ride is approved, offered, claimed, or started.
 */
import { checkAuthority, checkConsent, type ConsentContext, type ConsentRecordSnapshot, type GuardianAuthority } from "./consent.ts";
import { requiredRestraint, vehicleSatisfiesRestraint, type CapabilitySnapshot, type ChildMeasurements, type RestraintPolicy } from "./restraints.ts";

export interface MinorGateInput {
  minorRidesEnabled: boolean;
  gatesSatisfied: boolean;
  authority: GuardianAuthority | null;
  dependentProfileId: string;
  guardianUserId: string;
  consentRecords: ConsentRecordSnapshot[];
  consentContext: ConsentContext;
  child: ChildMeasurements;
  restraintPolicy: RestraintPolicy;
  /** Null when no driver is assigned yet; the restraint check then reports pending. */
  driver: { approval_tier: string; eligibility_status: string } | null;
  vehicleCapabilities: CapabilitySnapshot[];
  vehicleHasRearSeat: boolean;
  today: string;
}

export interface MinorGateVerdict {
  allowed: boolean;
  /** Every unmet requirement, in the order a coordinator would work through them. */
  blocking: { code: string; message: string }[];
  /** Requirements that passed, recorded on the ride for explainability. */
  satisfied: string[];
  requiredRestraint?: string;
}

export function checkMinorRide(input: MinorGateInput): MinorGateVerdict {
  const blocking: { code: string; message: string }[] = [];
  const satisfied: string[] = [];

  // 1. Flag and launch gates.
  if (!input.minorRidesEnabled) {
    blocking.push({
      code: "minor_rides_disabled",
      message: "Rides for under-18s are switched off. Nothing about a child's trip can proceed.",
    });
  } else {
    satisfied.push("minor_rides_flag_enabled");
  }
  if (!input.gatesSatisfied) {
    blocking.push({
      code: "launch_gates_incomplete",
      message: "The safeguarding, restraint, insurance and screening gates are not all complete and unexpired.",
    });
  } else {
    satisfied.push("launch_gates_complete");
  }

  // 2. Guardian authority.
  const authority = checkAuthority(input.authority, input.dependentProfileId, input.guardianUserId, input.today);
  if (!authority.ok) {
    blocking.push({ code: authority.code, message: authority.message });
  } else {
    satisfied.push("guardian_authority_verified");
  }

  // 3. Consent for this exact trip, on the current wording.
  const consent = checkConsent(input.consentRecords, input.consentContext);
  if (!consent.ok) {
    blocking.push({ code: consent.code, message: consent.message });
  } else {
    satisfied.push("guardian_consent_current");
  }

  // 4. Driver tier. General adult approval is never enough.
  if (!input.driver) {
    blocking.push({ code: "no_driver_assigned", message: "No driver is assigned yet." });
  } else if (input.driver.approval_tier !== "minor_transport_approved") {
    blocking.push({
      code: "missing_minor_transport_tier",
      message: "This driver is approved for adults only. Carrying a child needs the separate minor-transport approval.",
    });
  } else if (input.driver.eligibility_status !== "eligible") {
    blocking.push({
      code: `driver_${input.driver.eligibility_status}`,
      message: "This driver is not currently eligible to drive.",
    });
  } else {
    satisfied.push("driver_minor_transport_tier");
  }

  // 5. The right restraint, actually in the car, actually checked.
  const requirement = requiredRestraint(input.child, input.restraintPolicy);
  if (requirement.needs_more_information) {
    blocking.push({
      code: "restraint_information_incomplete",
      message: `${requirement.reason} A coordinator needs the missing detail before this can go ahead.`,
    });
  }
  if (input.driver) {
    const check = vehicleSatisfiesRestraint(
      requirement, input.vehicleCapabilities, input.today, input.vehicleHasRearSeat,
    );
    if (!check.satisfied) {
      blocking.push({ code: check.code, message: check.message });
    } else {
      satisfied.push(`restraint_verified:${requirement.required}`);
    }
  }
  if (!requirement.policy_reviewed) {
    blocking.push({
      code: "restraint_policy_unreviewed",
      message:
        "The child restraint rules in this system have not been checked against the statute by counsel. Complete the child_restraint launch gate first.",
    });
  }

  return {
    allowed: blocking.length === 0,
    blocking,
    satisfied,
    requiredRestraint: requirement.required,
  };
}
