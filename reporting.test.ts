import { describe, expect, it } from "vitest";
import { buildReport, scopeFacts, SMALL_CELL_THRESHOLD, toCsv, type RideFact } from "@shared/reporting";

function fact(overrides: Partial<RideFact> = {}): RideFact {
  return {
    ride_id: "r1",
    rider_user_id: "u1",
    status: "completed",
    resource_category: "free_fridge",
    pickup_zip: "48205",
    requested_pickup_at: "2026-06-10T10:00:00Z",
    arrival_by_at: "2026-06-10T11:00:00Z",
    completed_at: "2026-06-10T10:45:00Z",
    passenger_count: 1,
    rider_kind: "adult",
    accommodations_requested: [],
    accommodations_fulfilled: [],
    miles: 4,
    volunteer_minutes: 60,
    ...overrides,
  };
}

/** Enough distinct riders to clear the suppression threshold. */
function manyRiders(count: number, overrides: Partial<RideFact> = {}): RideFact[] {
  return Array.from({ length: count }, (_, i) =>
    fact({ ride_id: `r${i}`, rider_user_id: `u${i}`, ...overrides }));
}

const RANGE = { from: "2026-06-01T00:00:00Z", to: "2026-06-30T23:59:59Z" };

describe("report scoping", () => {
  it("pins an organization report to that organization's own participants", () => {
    const facts = [
      ...manyRiders(6, { organization_id: "org-a" }),
      ...manyRiders(6, { organization_id: "org-b" }).map((f) => ({ ...f, rider_user_id: `b-${f.rider_user_id}` })),
    ];
    const scoped = scopeFacts(facts, { audience: "organization", organizationId: "org-a", ...RANGE });
    expect(scoped).toHaveLength(6);
    expect(scoped.every((f) => f.organization_id === "org-a")).toBe(true);
  });

  it("pins a partner report to that partner's own destinations", () => {
    const facts = [
      ...manyRiders(6, { partner_id: "p-1" }),
      ...manyRiders(6, { partner_id: "p-2" }).map((f) => ({ ...f, rider_user_id: `x-${f.rider_user_id}` })),
    ];
    const scoped = scopeFacts(facts, { audience: "partner", partnerId: "p-1", ...RANGE });
    expect(scoped.every((f) => f.partner_id === "p-1")).toBe(true);
  });

  it("keeps minors out of every report except a staff one", () => {
    const facts = [...manyRiders(6), ...manyRiders(6, { rider_kind: "minor" }).map((f) => ({ ...f, rider_user_id: `m-${f.rider_user_id}` }))];
    expect(scopeFacts(facts, { audience: "partner", ...RANGE })).toHaveLength(6);
    expect(scopeFacts(facts, { audience: "organization", ...RANGE })).toHaveLength(6);
    expect(scopeFacts(facts, { audience: "public", ...RANGE })).toHaveLength(6);
    expect(scopeFacts(facts, { audience: "staff", ...RANGE })).toHaveLength(12);
  });

  it("respects the date range", () => {
    const facts = [
      ...manyRiders(6, { requested_pickup_at: "2026-06-10T10:00:00Z" }),
      ...manyRiders(6, { requested_pickup_at: "2026-08-10T10:00:00Z" }).map((f) => ({ ...f, rider_user_id: `late-${f.rider_user_id}` })),
    ];
    expect(scopeFacts(facts, { audience: "staff", ...RANGE })).toHaveLength(6);
  });
});

describe("small-cell suppression", () => {
  it("suppresses a cell built from fewer than the threshold number of people", () => {
    const report = buildReport(manyRiders(SMALL_CELL_THRESHOLD - 1), { audience: "partner", ...RANGE });
    expect(report.totals.requests).toBe("suppressed");
    expect(report.totals.unique_riders).toBe("suppressed");
    expect(report.suppressed_cells.length).toBeGreaterThan(0);
  });

  it("shows the number once enough people sit behind it", () => {
    const report = buildReport(manyRiders(SMALL_CELL_THRESHOLD), { audience: "partner", ...RANGE });
    expect(report.totals.requests).toBe(SMALL_CELL_THRESHOLD);
    expect(report.totals.unique_riders).toBe(SMALL_CELL_THRESHOLD);
  });

  it("never suppresses for staff", () => {
    const report = buildReport(manyRiders(1), { audience: "staff", ...RANGE });
    expect(report.totals.requests).toBe(1);
    expect(report.suppressed_cells).toEqual([]);
  });

  it("distinguishes a true zero from a withheld number", () => {
    const report = buildReport([], { audience: "partner", ...RANGE });
    expect(report.totals.requests).toBe(0);
    expect(report.totals.completed).toBe(0);
    expect(report.suppressed_cells).toEqual([]);
  });

  it("suppresses a thin breakdown even inside an otherwise large report", () => {
    const facts = [
      ...manyRiders(8, { resource_category: "free_fridge" }),
      // One person, one category: identifiable if published.
      fact({ ride_id: "solo", rider_user_id: "solo-user", resource_category: "social_services" }),
    ];
    const report = buildReport(facts, { audience: "partner", ...RANGE });
    expect(report.by_resource_category.free_fridge).toBe(8);
    expect(report.by_resource_category.social_services).toBe("suppressed");
  });

  it("suppresses the on-time rate rather than rounding a tiny denominator", () => {
    const thin = buildReport(manyRiders(2), { audience: "organization", ...RANGE });
    expect(thin.totals.on_time_rate).toBe("suppressed");
    const wide = buildReport(manyRiders(10), { audience: "organization", ...RANGE });
    expect(wide.totals.on_time_rate).toBe(1);
  });

  it("counts a late arrival against the on-time rate", () => {
    const facts = [
      ...manyRiders(9),
      fact({ ride_id: "late", rider_user_id: "u-late", completed_at: "2026-06-10T12:00:00Z" }),
    ];
    const report = buildReport(facts, { audience: "staff", ...RANGE });
    expect(report.totals.on_time_rate).toBe(0.9);
  });

  it("tells the reader that suppression is happening", () => {
    const report = buildReport(manyRiders(6), { audience: "organization", ...RANGE });
    expect(report.notes.join(" ")).toContain("suppressed");
    expect(report.notes.join(" ").toLowerCase()).toContain("under-18");
  });
});

describe("report content limits", () => {
  it("never carries an address, coordinate, phone number, or narrative", () => {
    const report = buildReport(manyRiders(6), { audience: "staff", ...RANGE });
    const blob = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["address", "latitude", "longitude", "phone", "narrative", "verification_code", "operational_notes"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("aggregates accommodations requested against provided", () => {
    const facts = manyRiders(6, {
      accommodations_requested: ["wheelchair_lift"],
      accommodations_fulfilled: ["wheelchair_lift"],
    });
    const report = buildReport(facts, { audience: "staff", ...RANGE });
    expect(report.accommodations.requested.wheelchair_lift).toBe(6);
    expect(report.accommodations.fulfilled.wheelchair_lift).toBe(6);
  });
});

describe("csv export", () => {
  it("writes a suppressed cell as the word, never as zero", () => {
    const report = buildReport(manyRiders(2), { audience: "partner", ...RANGE });
    const csv = toCsv(report);
    expect(csv).toContain("requests,suppressed");
    expect(csv).not.toContain("requests,0");
  });

  it("quotes any field containing a comma or quote", () => {
    const report = buildReport(manyRiders(6, { resource_category: 'odd,"category' }), { audience: "staff", ...RANGE });
    const csv = toCsv(report);
    expect(csv).toContain('"resource_category.odd,""category"');
  });
});
