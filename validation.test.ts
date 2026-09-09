import { describe, expect, it } from "vitest";
import { stripToAccepted, validateRideRequest } from "@shared/validation";
import { resolveConfig } from "@shared/flags";

const NOW = new Date("2026-09-08T09:00:00Z");
const IN_THREE_DAYS = "2026-09-11T10:00:00Z";
const IN_TWO_HOURS = "2026-09-08T11:00:00Z";

const config = resolveConfig(null);

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    pickup_address: "1 Example Way, Detroit, MI 48205",
    destination_location_id: "loc-1",
    requested_pickup_at: IN_THREE_DAYS,
    passenger_count: 1,
    ...overrides,
  };
}

describe("ride request validation", () => {
  it("accepts a well-formed adult pilot request", () => {
    const result = validateRideRequest(baseInput(), config, NOW);
    expect(result.ok).toBe(true);
  });

  it("rejects a request inside the lead time when same-day is off", () => {
    const result = validateRideRequest(baseInput({ requested_pickup_at: IN_TWO_HOURS }), config, NOW);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("insufficient_lead_time");
  });

  it("flags rather than rejects short notice once same-day is enabled", () => {
    const sameDay = resolveConfig({ same_day_rides_enabled: true });
    const result = validateRideRequest(baseInput({ requested_pickup_at: IN_TWO_HOURS }), sameDay, NOW);
    expect(result.ok).toBe(true);
    expect(result.flags).toContain("short_notice_request");
  });

  it("blocks minor rides while the flag is off", () => {
    const result = validateRideRequest(baseInput({ rider_kind: "minor" }), config, NOW);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "minor_rides_disabled")).toBe(true);
  });

  it("refuses an organization request without a recorded participant authorization", () => {
    const result = validateRideRequest(
      baseInput({ requested_by_kind: "org_scheduler", organization_id: "org-1" }), config, NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "participant_authorization_required")).toBe(true);
  });

  it("never lets a scheduler stand in as a guardian, even with an authorization on file", () => {
    const permissive = resolveConfig({ minor_rides_enabled: true });
    const result = validateRideRequest(
      baseInput({
        rider_kind: "minor",
        requested_by_kind: "org_scheduler",
        organization_id: "org-1",
        participant_authorization_id: "auth-1",
      }),
      permissive, NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "scheduler_cannot_consent")).toBe(true);
  });

  it("refuses sensitive fields the platform does not collect", () => {
    const result = validateRideRequest(
      { ...baseInput(), diagnosis: "n/a", ssn: "000-00-0000", immigration_status: "n/a" } as never,
      config, NOW,
    );
    expect(result.errors.filter((e) => e.code === "field_not_collected").length).toBe(3);
  });

  it("drops anything not on the accepted-field allowlist", () => {
    const stripped = stripToAccepted({
      ...baseInput(),
      status: "completed",
      fare_charged_cents: 5000,
      verification_code: "AAAAAA",
      rider_user_id: "someone-else",
      eligibility_flags: [],
    });
    expect(stripped).not.toHaveProperty("status");
    expect(stripped).not.toHaveProperty("fare_charged_cents");
    expect(stripped).not.toHaveProperty("verification_code");
    expect(stripped).not.toHaveProperty("rider_user_id");
    expect(stripped.pickup_address).toBe("1 Example Way, Detroit, MI 48205");
  });

  it("records that fulfillment is off and the geocoder is mocked, without blocking the request", () => {
    const result = validateRideRequest(baseInput(), config, NOW);
    expect(result.flags).toContain("fulfillment_disabled_request_queued_only");
    expect(result.flags).toContain("geocoder_in_mock_mode");
  });

  it("rejects an arrival time before the pickup time and an out-of-range passenger count", () => {
    expect(
      validateRideRequest(baseInput({ arrival_by_at: "2026-09-11T09:00:00Z" }), config, NOW)
        .errors.some((e) => e.code === "arrival_before_pickup"),
    ).toBe(true);
    expect(
      validateRideRequest(baseInput({ passenger_count: 20 }), config, NOW)
        .errors.some((e) => e.code === "out_of_range"),
    ).toBe(true);
  });
});
