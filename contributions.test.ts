import { describe, expect, it } from "vitest";
import {
  contributionAffectsRideAccess, summariseFulfillment, validatePledge,
  type CatalogItem, type FulfillmentRecord,
} from "@shared/contributions";

const TODAY = "2026-09-09";

const hoursItem: CatalogItem = {
  id: "item-hours", kind: "volunteer_hours", title: "Volunteer driving hours",
  unit_label: "hours", target_quantity: 40, active: true,
};
const suppliesItem: CatalogItem = {
  id: "item-water", kind: "supplies", title: "Cases of water",
  unit_label: "cases", target_quantity: 20, active: true,
};

describe("pledge validation", () => {
  it("accepts a plain offer of hours", () => {
    const r = validatePledge({ catalog_item_id: hoursItem.id, quantity: 10 }, hoursItem, TODAY);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("refuses wording that ties the offer to somebody's ride", () => {
    const phrases = [
      "20 hours in exchange for rides for our clients",
      "We can do this provided that they get priority for pickups",
      "Our participants must volunteer to earn their rides",
      "Cases of water in lieu of payment for the rides",
      "Happy to help so they can get a ride sooner",
    ];
    for (const note of phrases) {
      const r = validatePledge({ catalog_item_id: hoursItem.id, quantity: 20, note }, hoursItem, TODAY);
      expect(r.ok, note).toBe(false);
      expect(r.errors.map((e) => e.code)).toContain("conditional_language");
      expect(r.errors[0].message.toLowerCase()).toContain("free and unconditional");
    }
  });

  it("allows an ordinary practical note", () => {
    const r = validatePledge(
      { catalog_item_id: suppliesItem.id, quantity: 5, note: "We can drop these at the Gratiot door on Tuesdays." },
      suppliesItem, TODAY,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown or retired item", () => {
    expect(validatePledge({ catalog_item_id: "nope", quantity: 5 }, null, TODAY).errors[0].code).toBe("unknown_item");
    expect(validatePledge({ catalog_item_id: hoursItem.id, quantity: 5 }, { ...hoursItem, active: false }, TODAY).errors[0].code)
      .toBe("item_inactive");
  });

  it("rejects a nonsensical quantity and a past window", () => {
    expect(validatePledge({ catalog_item_id: hoursItem.id, quantity: 0 }, hoursItem, TODAY).errors[0].code)
      .toBe("invalid_quantity");
    expect(validatePledge({ catalog_item_id: hoursItem.id, quantity: 99_999 }, hoursItem, TODAY).errors[0].code)
      .toBe("implausible_quantity");
    expect(
      validatePledge({ catalog_item_id: hoursItem.id, quantity: 5, ends_on: "2026-01-01" }, hoursItem, TODAY)
        .errors.map((e) => e.code),
    ).toContain("in_the_past");
    expect(
      validatePledge({ catalog_item_id: hoursItem.id, quantity: 5, starts_on: "2026-12-01", ends_on: "2026-11-01" }, hoursItem, TODAY)
        .errors.map((e) => e.code),
    ).toContain("end_before_start");
  });

  it("warns without blocking when an offer is far above what was asked for", () => {
    const r = validatePledge({ catalog_item_id: hoursItem.id, quantity: 200 }, hoursItem, TODAY);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(1);
  });
});

describe("fulfillment summary", () => {
  const record = (quantity: number, verified = false): FulfillmentRecord => ({
    pledge_id: "p1", quantity, occurred_on: "2026-09-01", verified,
  });

  it("marks a pledge fulfilled once everything has arrived", () => {
    const s = summariseFulfillment(10, [record(6), record(4)], "accepted", TODAY);
    expect(s.status).toBe("fulfilled");
    expect(s.fulfilled).toBe(10);
    expect(s.outstanding).toBe(0);
  });

  it("marks it partially fulfilled part way through", () => {
    const s = summariseFulfillment(10, [record(4)], "accepted", TODAY);
    expect(s.status).toBe("partially_fulfilled");
    expect(s.outstanding).toBe(6);
  });

  it("lapses a window that closed short, with no consequence attached", () => {
    const s = summariseFulfillment(10, [record(2)], "accepted", TODAY, "2026-08-01");
    expect(s.status).toBe("lapsed");
    expect(s.consequences_of_shortfall.toLowerCase()).toContain("no debt");
    expect(s.consequences_of_shortfall.toLowerCase()).toContain("no restriction");
  });

  it("never produces a negative balance, even on an over-delivery", () => {
    const s = summariseFulfillment(10, [record(25)], "accepted", TODAY);
    expect(s.outstanding).toBe(0);
    expect(s.fulfilled).toBe(25);
  });

  it("counts verified separately from recorded", () => {
    const s = summariseFulfillment(10, [record(6, true), record(4, false)], "accepted", TODAY);
    expect(s.fulfilled).toBe(10);
    expect(s.verified).toBe(6);
  });

  it("leaves a declined or withdrawn pledge alone", () => {
    expect(summariseFulfillment(10, [], "declined", TODAY).status).toBe("declined");
    expect(summariseFulfillment(10, [], "withdrawn", TODAY).status).toBe("withdrawn");
  });

  it("exposes no field a ride decision could consume", () => {
    const s = summariseFulfillment(10, [record(3)], "accepted", TODAY);
    const keys = Object.keys(s);
    for (const forbidden of ["priority", "credit", "balance", "tier", "eligibility", "score", "rank"]) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
    expect(contributionAffectsRideAccess()).toBe(false);
  });
});
