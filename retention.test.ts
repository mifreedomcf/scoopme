import { describe, expect, it } from "vitest";
import {
  anonymizationPatch, decideSweep, DEFAULT_RETENTION_RULES, NEVER_SWEPT,
  rulesFromConfig, type HoldSnapshot,
} from "@shared/retention";

const TODAY = "2026-09-12";
const rules = DEFAULT_RETENTION_RULES;
const noHolds: HoldSnapshot[] = [];

const old = (days: number) =>
  new Date(new Date(`${TODAY}T00:00:00Z`).getTime() - days * 86_400_000).toISOString();

describe("the schedule itself", () => {
  it("expires precise location soonest of anything", () => {
    const location = rules.find((r) => r.entity === "LocationEvent")!;
    const others = rules.filter((r) => r.action !== "keep" && r.entity !== "LocationEvent");
    for (const r of others) expect(location.retain_days).toBeLessThan(r.retain_days);
  });

  it("never sweeps audit, incident, or consent records", () => {
    for (const entity of ["AuditLog", "SafetyIncident", "ConsentRecord", "LegalAcceptance", "DataRetentionHold"]) {
      expect(NEVER_SWEPT).toContain(entity);
    }
    for (const entity of ["AuditLog", "SafetyIncident", "ConsentRecord"]) {
      expect(decideSweep({ entity, id: "x", anchor_value: old(9999) }, rules, noHolds, TODAY).action).toBe("keep");
    }
  });

  it("anonymizes rides rather than deleting them, stripping everything identifying", () => {
    const rule = rules.find((r) => r.entity === "RideRequest")!;
    expect(rule.action).toBe("anonymize");
    for (const field of ["pickup_address", "contact_phone", "verification_code", "rider_user_id", "pickup_latitude"]) {
      expect(rule.anonymize_fields).toContain(field);
    }
  });

  it("strips the PIN and named adults from an old handoff", () => {
    const rule = rules.find((r) => r.entity === "HandoffRecord")!;
    expect(rule.anonymize_fields).toContain("pin");
    expect(rule.anonymize_fields).toContain("verified_adult_id");
  });
});

describe("deciding what happens to one record", () => {
  it("keeps a record inside its window and acts once past it", () => {
    expect(decideSweep({ entity: "LocationEvent", id: "l1", anchor_value: old(3) }, rules, noHolds, TODAY).action)
      .toBe("keep");
    expect(decideSweep({ entity: "LocationEvent", id: "l1", anchor_value: old(30) }, rules, noHolds, TODAY).action)
      .toBe("delete");
    expect(decideSweep({ entity: "RideRequest", id: "r1", anchor_value: old(9999) }, rules, noHolds, TODAY).action)
      .toBe("anonymize");
  });

  it("lets a hold beat the schedule", () => {
    const holds: HoldSnapshot[] = [{ scope_entity: "RideRequest", scope_id: "r1", is_active: true }];
    const d = decideSweep({ entity: "RideRequest", id: "r1", anchor_value: old(9999) }, rules, holds, TODAY);
    expect(d.action).toBe("keep");
    expect(d.code).toBe("under_hold");
    // A hold on one record does not protect another.
    expect(decideSweep({ entity: "RideRequest", id: "r2", anchor_value: old(9999) }, rules, holds, TODAY).action)
      .toBe("anonymize");
  });

  it("honours an entity-wide hold with no specific id", () => {
    const holds: HoldSnapshot[] = [{ scope_entity: "LocationEvent", is_active: true }];
    expect(decideSweep({ entity: "LocationEvent", id: "anything", anchor_value: old(999) }, rules, holds, TODAY).code)
      .toBe("under_hold");
  });

  it("ignores a released hold", () => {
    const holds: HoldSnapshot[] = [{ scope_entity: "LocationEvent", scope_id: "l1", is_active: false }];
    expect(decideSweep({ entity: "LocationEvent", id: "l1", anchor_value: old(999) }, rules, holds, TODAY).action)
      .toBe("delete");
  });

  it("deletes nothing when the hold table cannot be read", () => {
    const d = decideSweep({ entity: "LocationEvent", id: "l1", anchor_value: old(999) }, rules, null, TODAY);
    expect(d.action).toBe("keep");
    expect(d.code).toBe("holds_unreadable");
  });

  it("keeps a record with no rule, no date, or an unreadable date", () => {
    expect(decideSweep({ entity: "SomethingNew", id: "x", anchor_value: old(999) }, rules, noHolds, TODAY).code)
      .toBe("no_rule");
    expect(decideSweep({ entity: "LocationEvent", id: "x" }, rules, noHolds, TODAY).code).toBe("no_anchor_date");
    expect(decideSweep({ entity: "LocationEvent", id: "x", anchor_value: "not a date" }, rules, noHolds, TODAY).code)
      .toBe("bad_anchor_date");
  });
});

describe("anonymization", () => {
  it("blanks strings, nulls numbers, and stamps the row", () => {
    const patch = anonymizationPatch(["pickup_address", "pickup_latitude", "volunteer_minutes"]);
    expect(patch.pickup_address).toBe("");
    expect(patch.pickup_latitude).toBeNull();
    expect(patch.volunteer_minutes).toBeNull();
    expect(patch.anonymized_at).toBeTruthy();
  });
});

describe("admin overrides", () => {
  it("merges a sensible override and ignores a nonsensical one", () => {
    const merged = rulesFromConfig({ LocationEvent: 3, Message: -5, Unknown: 10 });
    expect(merged.find((r) => r.entity === "LocationEvent")!.retain_days).toBe(3);
    expect(merged.find((r) => r.entity === "Message")!.retain_days).toBe(180);
    expect(merged.find((r) => r.entity === "Unknown")).toBeUndefined();
  });

  it("falls back to the defaults with no overrides", () => {
    expect(rulesFromConfig(undefined)).toEqual(DEFAULT_RETENTION_RULES);
  });

  it("cannot turn a protected entity into a swept one", () => {
    const merged = rulesFromConfig({ AuditLog: 1 });
    expect(decideSweep({ entity: "AuditLog", id: "a1", anchor_value: old(999) }, merged, noHolds, TODAY).action)
      .toBe("keep");
  });
});
