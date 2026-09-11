import { describe, expect, it } from "vitest";
import {
  MICHIGAN_DEFAULT_POLICY, policyFromConfig, requiredRestraint,
  vehicleSatisfiesRestraint, type CapabilitySnapshot,
} from "@shared/restraints";

const TODAY = "2026-09-10";
const REVIEWED = { ...MICHIGAN_DEFAULT_POLICY, legally_reviewed: true };

describe("which restraint a child needs", () => {
  it("keeps an under-2 rear facing", () => {
    expect(requiredRestraint({ age_years: 1 }, REVIEWED).required).toBe("rear_facing_car_seat");
    expect(requiredRestraint({ age_years: 0 }, REVIEWED).required).toBe("rear_facing_car_seat");
  });

  it("moves a 2-to-4 year old to a harnessed forward-facing seat", () => {
    expect(requiredRestraint({ age_years: 2 }, REVIEWED).required).toBe("forward_facing_car_seat");
    expect(requiredRestraint({ age_years: 4 }, REVIEWED).required).toBe("forward_facing_car_seat");
  });

  it("keeps a 2-year-old rear facing when the guardian says the seat limits still apply", () => {
    const r = requiredRestraint({ age_years: 3, guardian_states_exceeds_rear_facing_limits: false }, REVIEWED);
    expect(r.required).toBe("rear_facing_car_seat");
  });

  it("puts a 5-to-7 year old in a booster unless they are tall enough", () => {
    expect(requiredRestraint({ age_years: 6 }, REVIEWED).required).toBe("booster_seat");
    expect(requiredRestraint({ age_years: 6, height_inches: 56 }, REVIEWED).required).toBe("booster_seat");
    expect(requiredRestraint({ age_years: 6, height_inches: 57 }, REVIEWED).required).toBe("seat_belt");
  });

  it("flags the missing height rather than guessing the permissive answer", () => {
    const r = requiredRestraint({ age_years: 6 }, REVIEWED);
    expect(r.needs_more_information).toBe(true);
    expect(r.required).toBe("booster_seat");
  });

  it("lets an 8-year-old use a belt, still in the rear seat", () => {
    const r = requiredRestraint({ age_years: 8 }, REVIEWED);
    expect(r.required).toBe("seat_belt");
    expect(r.rear_seat_required).toBe(true);
  });

  it("lifts the rear-seat requirement at 13", () => {
    expect(requiredRestraint({ age_years: 12 }, REVIEWED).rear_seat_required).toBe(true);
    expect(requiredRestraint({ age_years: 13 }, REVIEWED).rear_seat_required).toBe(false);
  });

  it("falls to the most protective option when the age is unusable", () => {
    const r = requiredRestraint({ age_years: Number.NaN }, REVIEWED);
    expect(r.required).toBe("rear_facing_car_seat");
    expect(r.rear_seat_required).toBe(true);
    expect(r.needs_more_information).toBe(true);
  });

  it("ships unreviewed by default and says so", () => {
    expect(MICHIGAN_DEFAULT_POLICY.legally_reviewed).toBe(false);
    expect(MICHIGAN_DEFAULT_POLICY.source_note).toContain("REQUIRES LEGAL REVIEW");
    expect(requiredRestraint({ age_years: 6 }).policy_reviewed).toBe(false);
  });

  it("reads thresholds from admin settings and never infers the review flag", () => {
    const policy = policyFromConfig({
      restraint_rear_facing_max_age: 3,
      restraint_booster_max_age: 9,
      restraint_policy_reviewed: true,
    });
    expect(policy.rear_facing_max_age).toBe(3);
    expect(policy.booster_max_age).toBe(9);
    expect(policy.legally_reviewed).toBe(true);
    expect(policyFromConfig({}).legally_reviewed).toBe(false);
    expect(policyFromConfig({ restraint_policy_reviewed: "yes" }).legally_reviewed).toBe(false);
  });
});

describe("does this car actually have the right seat", () => {
  const verified: CapabilitySnapshot[] = [
    { capability: "booster_seat", quantity: 1, verification_status: "verified", expiration_date: "2027-01-01" },
  ];

  it("accepts a verified, unexpired restraint", () => {
    const requirement = requiredRestraint({ age_years: 6, height_inches: 50 }, REVIEWED);
    expect(vehicleSatisfiesRestraint(requirement, verified, TODAY).satisfied).toBe(true);
  });

  it("refuses a self-reported one", () => {
    const requirement = requiredRestraint({ age_years: 6, height_inches: 50 }, REVIEWED);
    const check = vehicleSatisfiesRestraint(
      requirement,
      [{ capability: "booster_seat", quantity: 1, verification_status: "self_reported" }],
      TODAY,
    );
    expect(check.satisfied).toBe(false);
    expect(check.code).toBe("restraint_not_verified");
  });

  it("refuses a missing one, an expired one, and an empty one", () => {
    const requirement = requiredRestraint({ age_years: 6, height_inches: 50 }, REVIEWED);
    expect(vehicleSatisfiesRestraint(requirement, [], TODAY).code).toBe("restraint_not_available");
    expect(vehicleSatisfiesRestraint(requirement,
      [{ capability: "booster_seat", quantity: 1, verification_status: "verified", expiration_date: "2026-01-01" }], TODAY).code)
      .toBe("restraint_expired");
    expect(vehicleSatisfiesRestraint(requirement,
      [{ capability: "booster_seat", quantity: 0, verification_status: "verified" }], TODAY).code)
      .toBe("restraint_quantity");
  });

  it("refuses a car with no rear seat for a child who needs one", () => {
    const requirement = requiredRestraint({ age_years: 10 }, REVIEWED);
    const check = vehicleSatisfiesRestraint(requirement, [], TODAY, false);
    expect(check.satisfied).toBe(false);
    expect(check.code).toBe("no_rear_seat");
  });

  it("does not demand equipment for a child who only needs a belt", () => {
    const requirement = requiredRestraint({ age_years: 14 }, REVIEWED);
    expect(vehicleSatisfiesRestraint(requirement, [], TODAY).satisfied).toBe(true);
  });

  it("will not accept the wrong seat for the age", () => {
    const requirement = requiredRestraint({ age_years: 1 }, REVIEWED);
    const check = vehicleSatisfiesRestraint(requirement, verified, TODAY);
    expect(check.satisfied).toBe(false);
    expect(check.required).toBe("rear_facing_car_seat");
  });
});
