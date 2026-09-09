import { describe, expect, it } from "vitest";
import { canFulfillRides, checkGatesForFlag, evaluateFlagChange, resolveConfig, type GateRecord } from "@shared/flags";
import { FLAG_GATE_REQUIREMENTS } from "@shared/constants";

const TODAY = "2026-09-08";

function gatesFor(flag: string, overrides: Partial<GateRecord> = {}): GateRecord[] {
  return FLAG_GATE_REQUIREMENTS[flag].map((category, i) => ({
    gate_key: `${category}-${i}`,
    category,
    status: "complete",
    approved_date: "2026-01-01",
    ...overrides,
  }));
}

describe("feature flags and launch gates", () => {
  it("defaults every risky flag to off", () => {
    const config = resolveConfig(null);
    expect(config.minor_rides_enabled).toBe(false);
    expect(config.same_day_rides_enabled).toBe(false);
    expect(config.direct_driver_tips_enabled).toBe(false);
    expect(config.platform_donations_enabled).toBe(false);
    expect(config.live_location_enabled).toBe(false);
    expect(config.ride_fulfillment_enabled).toBe(false);
    expect(config.driver_tip_annual_cap_cents).toBe(0);
    expect(config.background_check_provider_mode).toBe("mock_pending_review");
    expect(config.operator_legal_name).toBe("Pilot Operator — To Be Confirmed");
    expect(config.allowed_destination_zip_codes).toEqual(["48205"]);
  });

  it("blocks enabling ride fulfillment while gates are incomplete", () => {
    const verdict = evaluateFlagChange(
      { flag: "ride_fulfillment_enabled", value: true },
      resolveConfig(null), [], TODAY,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("gate_not_overridable");
  });

  it("allows enabling once every required gate is complete and unexpired", () => {
    const verdict = evaluateFlagChange(
      { flag: "ride_fulfillment_enabled", value: true },
      resolveConfig(null), gatesFor("ride_fulfillment_enabled"), TODAY,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.usedOverride).toBe(false);
  });

  it("treats an expired gate as incomplete", () => {
    const gates = gatesFor("ride_fulfillment_enabled");
    gates[0].expires_date = "2026-01-31";
    expect(checkGatesForFlag("ride_fulfillment_enabled", gates, TODAY).satisfied).toBe(false);
    expect(canFulfillRides(resolveConfig({ ride_fulfillment_enabled: true }), gates, TODAY).allowed).toBe(false);
  });

  it("never lets an override bypass background checks, safeguarding, restraints, or insurance", () => {
    const gates = gatesFor("minor_rides_enabled");
    const bg = gates.find((g) => g.category === "background_checks")!;
    bg.status = "in_progress";
    const verdict = evaluateFlagChange(
      {
        flag: "minor_rides_enabled", value: true, reauthenticated: true,
        overrideJustification: "We have decided to proceed ahead of the vendor agreement for the launch event.",
      },
      resolveConfig(null), gates, TODAY,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("gate_not_overridable");
  });

  it("requires typed justification and re-authentication for an overridable gate", () => {
    const gates = gatesFor("live_location_enabled");
    gates[0].status = "in_progress";
    const config = resolveConfig(null);

    expect(evaluateFlagChange({ flag: "live_location_enabled", value: true }, config, gates, TODAY).code)
      .toBe("gate_incomplete");
    expect(
      evaluateFlagChange(
        { flag: "live_location_enabled", value: true, overrideJustification: "x".repeat(45) },
        config, gates, TODAY,
      ).code,
    ).toBe("reauth_required");

    const allowed = evaluateFlagChange(
      { flag: "live_location_enabled", value: true, overrideJustification: "x".repeat(45), reauthenticated: true },
      config, gates, TODAY,
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.usedOverride).toBe(true);
  });

  it("always permits turning a flag off", () => {
    expect(evaluateFlagChange({ flag: "ride_fulfillment_enabled", value: false }, resolveConfig(null), [], TODAY).allowed)
      .toBe(true);
  });

  it("refuses a driver age below the legal floor and refuses to lower the minor-transport age", () => {
    const config = resolveConfig(null);
    expect(evaluateFlagChange({ flag: "minimum_driver_age", value: 18 }, config, [], TODAY).code).toBe("below_legal_floor");
    expect(evaluateFlagChange({ flag: "minimum_driver_age", value: 23 }, config, [], TODAY).allowed).toBe(true);

    const raised = resolveConfig({ minimum_minor_transport_driver_age: 30 });
    expect(evaluateFlagChange({ flag: "minimum_minor_transport_driver_age", value: 27 }, raised, [], TODAY).code)
      .toBe("downward_change_blocked");
    expect(evaluateFlagChange({ flag: "minimum_minor_transport_driver_age", value: 32 }, raised, [], TODAY).allowed)
      .toBe(true);
  });

  it("keeps the tip cap at zero while tipping is disabled", () => {
    const config = resolveConfig(null);
    expect(evaluateFlagChange({ flag: "driver_tip_annual_cap_cents", value: 59900 }, config, [], TODAY).code)
      .toBe("tips_disabled");
  });
});
