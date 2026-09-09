import { describe, expect, it } from "vitest";
import { evaluateDriver, rankEligibleDrivers, REQUIRED_ADULT_CREDENTIALS, type DriverSnapshot, type RideMatchInput } from "@shared/matching";

const TODAY = "2026-09-08";

function credentials(types: string[], expiration = "2027-01-01") {
  return types.map((credential_type) => ({
    credential_type,
    required_for: "adult_transport" as const,
    status: "verified",
    expiration_date: expiration,
  }));
}

function driver(overrides: Partial<DriverSnapshot> = {}): DriverSnapshot {
  return {
    driver_profile_id: "driver-a",
    approval_tier: "adult_transport_approved",
    eligibility_status: "eligible",
    languages: ["en"],
    accepts_service_animals: true,
    max_travel_miles: 15,
    home_point: { lat: 42.3506, lng: -83.0295 },
    credentials: credentials(REQUIRED_ADULT_CREDENTIALS),
    capabilities: [],
    availability: [{ starts_at: "2026-09-10T08:00:00Z", ends_at: "2026-09-10T18:00:00Z", status: "active" }],
    bookedWindows: [],
    vehicleSeatingCapacity: 4,
    vehicleStatus: "active",
    vehicleInspectionOk: true,
    ...overrides,
  };
}

function ride(overrides: Partial<RideMatchInput> = {}): RideMatchInput {
  return {
    riderKind: "adult",
    passengerCount: 1,
    windowStart: "2026-09-10T10:00:00Z",
    windowEnd: "2026-09-10T11:00:00Z",
    serviceAnimal: false,
    needs: [],
    pickupPoint: { lat: 42.4302, lng: -82.9812 },
    maxVolunteerTravelMiles: 15,
    ...overrides,
  };
}

describe("deterministic matching", () => {
  it("matches a fully credentialed, available driver", () => {
    const verdict = evaluateDriver(driver(), ride(), TODAY);
    expect(verdict.eligible).toBe(true);
    expect(verdict.passed).toContain("required_credentials_current");
  });

  it("suspends a driver the moment a required credential expires", () => {
    const stale = driver({ credentials: credentials(REQUIRED_ADULT_CREDENTIALS, "2026-08-01") });
    const verdict = evaluateDriver(stale, ride(), TODAY);
    expect(verdict.eligible).toBe(false);
    expect(verdict.failures.some((f) => f.startsWith("credential_missing_or_expired"))).toBe(true);
  });

  it("refuses an unapproved driver", () => {
    expect(evaluateDriver(driver({ approval_tier: "none" }), ride(), TODAY).failures).toContain("driver_not_approved");
    expect(evaluateDriver(driver({ eligibility_status: "suspended_expired_credential" }), ride(), TODAY).eligible).toBe(false);
  });

  it("refuses a general adult driver for a minor ride", () => {
    const verdict = evaluateDriver(driver(), ride({ riderKind: "minor" }), TODAY);
    expect(verdict.eligible).toBe(false);
    expect(verdict.failures).toContain("missing_minor_transport_tier");
  });

  it("still refuses a minor-tier driver missing the extra minor checks", () => {
    const d = driver({ approval_tier: "minor_transport_approved" });
    const verdict = evaluateDriver(d, ride({ riderKind: "minor" }), TODAY);
    expect(verdict.failures).toContain("credential_missing_or_expired:fingerprinting");
    expect(verdict.failures).toContain("credential_missing_or_expired:child_abuse_neglect_registry");
  });

  it("will not satisfy an access need with a self-reported capability", () => {
    const selfReported = driver({
      capabilities: [{ capability: "wheelchair_lift", quantity: 1, verification_status: "self_reported" }],
    });
    const needsLift = ride({ needs: [{ need: "wheelchair_lift", quantity: 1, is_hard_requirement: true }] });
    expect(evaluateDriver(selfReported, needsLift, TODAY).failures).toContain("unverified_capability:wheelchair_lift");

    const verified = driver({
      capabilities: [{ capability: "wheelchair_lift", quantity: 1, verification_status: "verified" }],
    });
    expect(evaluateDriver(verified, needsLift, TODAY).eligible).toBe(true);
  });

  it("respects seating capacity, schedule conflicts, service animals, and travel distance", () => {
    expect(evaluateDriver(driver({ vehicleSeatingCapacity: 2 }), ride({ passengerCount: 5 }), TODAY).failures)
      .toContain("insufficient_seating_capacity");
    expect(
      evaluateDriver(
        driver({ bookedWindows: [{ starts_at: "2026-09-10T10:30:00Z", ends_at: "2026-09-10T12:00:00Z" }] }),
        ride(), TODAY,
      ).failures,
    ).toContain("schedule_conflict");
    expect(evaluateDriver(driver({ accepts_service_animals: false }), ride({ serviceAnimal: true }), TODAY).failures)
      .toContain("service_animal_not_accepted");
    expect(evaluateDriver(driver({ max_travel_miles: 1 }), ride(), TODAY).failures)
      .toContain("beyond_max_volunteer_travel_distance");
  });

  it("ranks eligible drivers nearest first and drops ineligible ones", () => {
    const near = driver({ driver_profile_id: "near", home_point: { lat: 42.4300, lng: -82.9810 } });
    const far = driver({ driver_profile_id: "far", home_point: { lat: 42.3314, lng: -83.0458 } });
    const broken = driver({ driver_profile_id: "broken", vehicleStatus: "retired" });
    const ranked = rankEligibleDrivers([far, broken, near], ride(), TODAY);
    expect(ranked.map((r) => r.driver.driver_profile_id)).toEqual(["near", "far"]);
  });
});
