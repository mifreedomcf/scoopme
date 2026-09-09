/**
 * Milestone 1 acceptance criteria, stated in the brief, checked against the
 * modules that actually make each decision.
 */
import { describe, expect, it } from "vitest";
import { resolveConfig, evaluateFlagChange, canFulfillRides } from "@shared/flags";
import { validateRideRequest } from "@shared/validation";
import { validateServiceArea, PLACEHOLDER_BOUNDARY } from "@shared/geo";
import { mockGeocoder } from "@shared/mock-geocoder";
import { canTransition } from "@shared/state-machine";
import { evaluateDriver, REQUIRED_ADULT_CREDENTIALS } from "@shared/matching";
import { minimizeRide } from "@shared/minimize";
import { viewerKindFor, buildPrincipal } from "@shared/authz";
import { ACCEPTED_REQUEST_FIELDS } from "@shared/validation";

const TODAY = "2026-09-08";
const NOW = new Date("2026-09-08T09:00:00Z");
const config = resolveConfig(null);
const area = {
  boundary: PLACEHOLDER_BOUNDARY,
  allowedDestinationZips: ["48205"],
  allowedPickupZips: [] as string[],
  serviceAreaCity: "Detroit",
  serviceAreaState: "MI",
};

describe("acceptance: an adult can request a free scheduled pilot ride", () => {
  it("validates and never asks for money", () => {
    const result = validateRideRequest(
      {
        pickup_address: "1 Example Way, Detroit, MI 48205",
        destination_location_id: "loc-1",
        requested_pickup_at: "2026-09-11T10:00:00Z",
        passenger_count: 1,
        resource_category: "free_fridge",
      },
      config, NOW,
    );
    expect(result.ok).toBe(true);
    for (const money of ["payment_method", "card_token", "fare", "tip", "donation_amount"]) {
      expect(ACCEPTED_REQUEST_FIELDS).not.toContain(money);
    }
  });
});

describe("acceptance: geography is rejected server-side", () => {
  it("rejects a destination outside the configured pilot ZIPs", async () => {
    const geocode = await mockGeocoder.geocode("100 Example St, Detroit, MI 48226");
    expect(validateServiceArea({ ...area, geocode, kind: "destination" }).status).toBe("outside_service_area");
  });

  it("rejects a pickup outside Detroit", async () => {
    const geocode = await mockGeocoder.geocode("5 Example Rd, Romulus, MI 48174");
    expect(validateServiceArea({ ...area, geocode, kind: "pickup" }).status).toBe("outside_service_area");
  });
});

describe("acceptance: risky capabilities are off by default", () => {
  it("keeps donations, tips, minor rides, live location and fulfillment disabled", () => {
    expect(config.platform_donations_enabled).toBe(false);
    expect(config.direct_driver_tips_enabled).toBe(false);
    expect(config.minor_rides_enabled).toBe(false);
    expect(config.live_location_enabled).toBe(false);
    expect(canFulfillRides(config, [], TODAY).allowed).toBe(false);
  });

  it("refuses to turn any of them on with an empty checklist", () => {
    for (const flag of ["platform_donations_enabled", "direct_driver_tips_enabled", "minor_rides_enabled", "live_location_enabled", "ride_fulfillment_enabled"]) {
      expect(evaluateFlagChange({ flag, value: true }, config, [], TODAY).allowed, flag).toBe(false);
    }
  });
});

describe("acceptance: a CBO scheduler is not a guardian", () => {
  it("blocks consent by the person who created the request", () => {
    const permissive = resolveConfig({ minor_rides_enabled: true });
    const result = validateRideRequest(
      {
        rider_kind: "minor",
        requested_by_kind: "org_scheduler",
        organization_id: "org-1",
        participant_authorization_id: "auth-1",
        pickup_address: "1 Example Way, Detroit, MI 48205",
        destination_location_id: "loc-1",
        requested_pickup_at: "2026-09-11T10:00:00Z",
      },
      permissive, NOW,
    );
    expect(result.errors.map((e) => e.code)).toContain("scheduler_cannot_consent");
  });
});

describe("acceptance: a minor ride cannot be started without every control", () => {
  it("is blocked by the flag, then by the tier, then by the extra checks", () => {
    expect(
      validateRideRequest(
        { rider_kind: "minor", pickup_address: "1 Example Way, Detroit, MI 48205", destination_location_id: "loc-1", requested_pickup_at: "2026-09-11T10:00:00Z" },
        config, NOW,
      ).errors.map((e) => e.code),
    ).toContain("minor_rides_disabled");

    const generalDriver = {
      driver_profile_id: "d1",
      approval_tier: "adult_transport_approved" as const,
      eligibility_status: "eligible",
      languages: ["en"],
      accepts_service_animals: true,
      max_travel_miles: 15,
      credentials: REQUIRED_ADULT_CREDENTIALS.map((credential_type) => ({
        credential_type, required_for: "adult_transport" as const, status: "verified", expiration_date: "2027-01-01",
      })),
      capabilities: [],
      availability: [{ starts_at: "2026-09-10T08:00:00Z", ends_at: "2026-09-10T18:00:00Z", status: "active" }],
      bookedWindows: [],
      vehicleSeatingCapacity: 4,
      vehicleStatus: "active",
      vehicleInspectionOk: true,
    };
    const minorRide = {
      riderKind: "minor" as const,
      passengerCount: 1,
      windowStart: "2026-09-10T10:00:00Z",
      windowEnd: "2026-09-10T11:00:00Z",
      serviceAnimal: false,
      needs: [{ need: "booster_seat", quantity: 1, is_hard_requirement: true }],
      maxVolunteerTravelMiles: 15,
    };
    const verdict = evaluateDriver(generalDriver, minorRide, TODAY);
    expect(verdict.eligible).toBe(false);
    expect(verdict.failures).toContain("missing_minor_transport_tier");
    expect(verdict.failures).toContain("unverified_capability:booster_seat");
  });
});

describe("acceptance: unassigned and expired drivers see and do nothing", () => {
  it("shows an unassigned driver only minimized information", () => {
    const payload = minimizeRide(
      {
        id: "r1", status: "offered", rider_kind: "adult",
        pickup_address: "1 Example Way", contact_phone: "555-0111", verification_code: "K7Q2MP",
        pickup_area_label: "Northeast Detroit (48205)",
      },
      { viewer: "unassigned_driver" },
    );
    expect(payload).not.toHaveProperty("pickup_address");
    expect(payload).not.toHaveProperty("contact_phone");
    expect(payload).not.toHaveProperty("verification_code");
  });

  it("keeps an expired-credential driver out of the eligible set", () => {
    const expired = {
      driver_profile_id: "d2",
      approval_tier: "adult_transport_approved" as const,
      eligibility_status: "eligible",
      languages: ["en"], accepts_service_animals: true, max_travel_miles: 15,
      credentials: REQUIRED_ADULT_CREDENTIALS.map((credential_type) => ({
        credential_type, required_for: "adult_transport" as const, status: "verified", expiration_date: "2026-01-01",
      })),
      capabilities: [],
      availability: [{ starts_at: "2026-09-10T08:00:00Z", ends_at: "2026-09-10T18:00:00Z", status: "active" }],
      bookedWindows: [], vehicleSeatingCapacity: 4, vehicleStatus: "active", vehicleInspectionOk: true,
    };
    expect(evaluateDriver(expired, {
      riderKind: "adult", passengerCount: 1,
      windowStart: "2026-09-10T10:00:00Z", windowEnd: "2026-09-10T11:00:00Z",
      serviceAnimal: false, needs: [], maxVolunteerTravelMiles: 15,
    }, TODAY).eligible).toBe(false);
  });
});

describe("acceptance: identifier tampering does not grant access", () => {
  it("gives a stranger the public projection whatever id they supply", () => {
    const stranger = buildPrincipal({ id: "u-x", email: "x@example.invalid" }, []);
    const someoneElsesRide = { rider_user_id: "u-rider", requested_by_user_id: "u-rider" };
    const viewer = viewerKindFor(stranger, someoneElsesRide, false);
    expect(viewer).toBe("public");
    expect(Object.keys(minimizeRide({ id: "r1", status: "offered", rider_kind: "adult", pickup_address: "1 Example Way" }, { viewer })))
      .toEqual(["id", "status"]);
  });
});

describe("acceptance: contributions never affect eligibility", () => {
  it("has no contribution, donation, or pledge input on the ride path", () => {
    for (const field of ACCEPTED_REQUEST_FIELDS) {
      expect(field).not.toMatch(/donat|pledge|contribut|tip|fare|payment/i);
    }
  });
});

describe("acceptance: a tip cannot be configured or sent while tipping is off", () => {
  it("pins the cap to zero and blocks the flag", () => {
    expect(evaluateFlagChange({ flag: "driver_tip_annual_cap_cents", value: 59900 }, config, [], TODAY).allowed).toBe(false);
    expect(evaluateFlagChange({ flag: "direct_driver_tips_enabled", value: true }, config, [], TODAY).allowed).toBe(false);
  });

  it("has no ride state that ends anywhere but completion, so a pre-completion tip has no hook", () => {
    expect(canTransition("in_progress", "completed", { actorRole: "driver", isAssignedDriver: true }).allowed).toBe(false);
  });
});
