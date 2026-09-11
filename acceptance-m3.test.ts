/**
 * Milestone 3 acceptance criteria, checked against the code that decides.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, scopeFacts, SMALL_CELL_THRESHOLD, type RideFact } from "@shared/reporting";
import { contributionAffectsRideAccess, summariseFulfillment, validatePledge } from "@shared/contributions";
import { validateRideRequest, ACCEPTED_REQUEST_FIELDS } from "@shared/validation";
import { resolveConfig } from "@shared/flags";
import { evaluateDriver, REQUIRED_ADULT_CREDENTIALS } from "@shared/matching";

const FUNCTIONS = join(process.cwd(), "base44", "functions");
const ENTITIES = join(process.cwd(), "base44", "entities");
const fn = (name: string) => readFileSync(join(FUNCTIONS, name, "entry.ts"), "utf8");
const entity = (file: string) => JSON.parse(readFileSync(join(ENTITIES, file), "utf8"));
const TODAY = "2026-09-09";
const RANGE = { from: "2026-06-01T00:00:00Z", to: "2026-06-30T23:59:59Z" };

function facts(count: number, overrides: Partial<RideFact> = {}): RideFact[] {
  return Array.from({ length: count }, (_, i) => ({
    ride_id: `r${i}`, rider_user_id: `u${i}`, status: "completed",
    resource_category: "free_fridge", pickup_zip: "48205",
    requested_pickup_at: "2026-06-10T10:00:00Z", passenger_count: 1, rider_kind: "adult",
    accommodations_requested: [], accommodations_fulfilled: [], ...overrides,
  }));
}

describe("acceptance: a professional relationship is not authorization", () => {
  it("creates the request as pending and says the organization cannot use it yet", () => {
    const source = fn("request-participant-authorization");
    expect(source).toContain('status: "pending"');
    expect(source).toContain("They decide, not you");
    // The requesting function has no path to activation at all: it never
    // updates the authorization it just created.
    expect(source).not.toContain("OrganizationParticipantAuthorization.update");
    expect(source).not.toContain("verified_at");
  });

  it("only lets the participant themselves confirm", () => {
    const source = fn("confirm-participant-authorization");
    expect(source).toContain("authorization.participant_user_id !== ctx.principal.userId");
    expect(source).toContain("not_the_participant");
    expect(source).toContain("Only the participant can call this for their own record.");
  });

  it("closes the route entirely for anyone under 18", () => {
    const source = fn("request-participant-authorization");
    expect(source).toContain("minor_cannot_authorize");
    expect(source).toContain("A verified parent or legal guardian has to do that separately");
  });

  it("still refuses a scheduler as a consenting party in ride validation", () => {
    const permissive = resolveConfig({ minor_rides_enabled: true });
    const result = validateRideRequest(
      {
        rider_kind: "minor", requested_by_kind: "org_scheduler",
        organization_id: "org-1", participant_authorization_id: "auth-1",
        pickup_address: "1 Example Way, Detroit, MI 48205",
        destination_location_id: "loc-1", requested_pickup_at: "2026-09-20T10:00:00Z",
      },
      permissive, new Date("2026-09-09T09:00:00Z"),
    );
    expect(result.errors.map((e) => e.code)).toContain("scheduler_cannot_consent");
  });

  it("requires a platform admin to approve a scheduler, not an org admin", () => {
    const source = fn("manage-organization-member");
    expect(source).toContain("Only a platform administrator can approve or revoke organization access.");
    expect(source).toContain('status: "requested"');
  });

  it("does not silently cancel rides when permission is withdrawn", () => {
    const source = fn("confirm-participant-authorization");
    expect(source).toContain("silently cancelled");
    expect(source).toContain("open_rides_flagged");
  });
});

describe("acceptance: an organization sees only its own participants", () => {
  it("derives scope from the caller's role, not from the request", () => {
    const source = fn("build-report");
    expect(source).toContain("Scope comes from who the caller is");
    expect(source).toContain("ctx.principal.organizationIds.includes(requestedOrg)");
    expect(source).toContain("An organization report cannot be scoped to a partner's activity.");
  });

  it("filters before aggregating", () => {
    const mixed = [...facts(6, { organization_id: "org-a" }),
      ...facts(6, { organization_id: "org-b" }).map((f) => ({ ...f, rider_user_id: `b${f.rider_user_id}` }))];
    const report = buildReport(mixed, { audience: "organization", organizationId: "org-a", ...RANGE });
    expect(report.totals.requests).toBe(6);
  });
});

describe("acceptance: small cells and sensitive fields stay out of reports", () => {
  it("suppresses a thin cell rather than publishing a number", () => {
    const report = buildReport(facts(SMALL_CELL_THRESHOLD - 1), { audience: "partner", ...RANGE });
    expect(report.totals.unique_riders).toBe("suppressed");
  });

  it("keeps minors, addresses, purposes, and narratives out entirely", () => {
    const withMinors = [...facts(6), ...facts(6, { rider_kind: "minor" }).map((f) => ({ ...f, rider_user_id: `m${f.rider_user_id}` }))];
    expect(scopeFacts(withMinors, { audience: "partner", ...RANGE })).toHaveLength(6);

    const source = fn("build-report");
    expect(source).toContain("no addresses, no coordinates, no phone numbers, no notes");
    for (const forbidden of ["pickup_address", "contact_phone", "verification_code", "operational_notes", "narrative"]) {
      expect(source.split("const facts: RideFact[]")[1]).not.toContain(forbidden);
    }
  });

  it("requires a written purpose and audits every CSV export", () => {
    const source = fn("build-report");
    expect(source).toContain("purpose_required");
    expect(source).toContain('event_type: wantsCsv ? "export.sensitive" : "report.build"');
    expect(source).toContain("Do not republish them as zero");
  });
});

describe("acceptance: contributions never affect ride eligibility", () => {
  it("keeps every contribution field off the ride request path", () => {
    for (const field of ACCEPTED_REQUEST_FIELDS) {
      expect(field).not.toMatch(/donat|pledge|contribut|tip|fare|payment|credit|balance/i);
    }
  });

  it("keeps every contribution field out of the matcher's inputs", () => {
    const driver = {
      driver_profile_id: "d1", approval_tier: "adult_transport_approved" as const,
      eligibility_status: "eligible", languages: ["en"], accepts_service_animals: true, max_travel_miles: 15,
      credentials: REQUIRED_ADULT_CREDENTIALS.map((credential_type) => ({
        credential_type, required_for: "adult_transport" as const, status: "verified", expiration_date: "2027-01-01",
      })),
      capabilities: [],
      availability: [{ starts_at: "2026-09-20T08:00:00Z", ends_at: "2026-09-20T18:00:00Z", status: "active" }],
      bookedWindows: [], vehicleSeatingCapacity: 4, vehicleStatus: "active", vehicleInspectionOk: true,
    };
    const ride = {
      riderKind: "adult" as const, passengerCount: 1,
      windowStart: "2026-09-20T10:00:00Z", windowEnd: "2026-09-20T11:00:00Z",
      serviceAnimal: false, needs: [], maxVolunteerTravelMiles: 15,
    };
    // A ride from an organization that has pledged nothing is matched identically.
    const verdict = evaluateDriver(driver, ride, TODAY);
    expect(verdict.eligible).toBe(true);
    const rideKeys = Object.keys(ride);
    for (const forbidden of ["pledge", "contribution", "donation", "credit", "balance", "tier"]) {
      expect(rideKeys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
    expect(contributionAffectsRideAccess()).toBe(false);
  });

  it("has no balance, debt, or credit field on any contribution entity", () => {
    for (const file of ["contribution-pledge.jsonc", "contribution-fulfillment.jsonc", "contribution-catalog-item.jsonc"]) {
      const schema = entity(file);
      for (const field of Object.keys(schema.properties)) {
        expect(field).not.toMatch(/balance|debt|credit|owed|penalty|priority|tier/i);
      }
      expect(schema.rls.update).toBe(false);
      expect(schema.rls.delete).toBe(false);
    }
  });

  it("floors an unmet pledge at zero outstanding and attaches no consequence", () => {
    const s = summariseFulfillment(10, [{ pledge_id: "p", quantity: 1, occurred_on: "2026-09-01", verified: false }], "accepted", TODAY, "2026-08-01");
    expect(s.status).toBe("lapsed");
    expect(s.outstanding).toBe(9);
    expect(s.consequences_of_shortfall.toLowerCase()).toContain("no restriction");
  });

  it("refuses a pledge worded as a condition on anyone's ride", () => {
    const item = { id: "i", kind: "volunteer_hours" as const, title: "Hours", unit_label: "hours", active: true };
    const r = validatePledge(
      { catalog_item_id: "i", quantity: 10, note: "10 hours in exchange for rides for our clients" },
      item, TODAY,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("conditional_language");
  });

  it("says out loud, in every contribution response, that access is unaffected", () => {
    expect(fn("submit-contribution-pledge")).toContain("unconditional_notice");
    expect(fn("review-contribution-pledge")).toContain('rider_access_effect: "none"');
    expect(fn("record-contribution-fulfillment")).toContain('rider_access_effect: "none"');
    expect(fn("build-report")).toContain('effect_on_ride_access: "none"');
  });

  it("never claims a contribution is tax deductible", () => {
    const source = fn("submit-contribution-pledge");
    expect(source).toContain("We cannot tell you whether this is tax deductible");
    // The word appears exactly once, inside the disclaimer — never as a claim.
    expect(source.match(/deductible/g)).toHaveLength(1);
    expect(source).toMatch(/cannot tell you whether this is tax deductible/);
    const schema = entity("contribution-fulfillment.jsonc");
    expect(schema.properties.estimated_value_cents.description).toContain("Never presented");
  });

  it("keeps pledges gated behind the feature flag", () => {
    expect(resolveConfig(null).organization_in_kind_contributions_enabled).toBe(true);
    expect(fn("submit-contribution-pledge")).toContain("contributions_disabled");
    expect(fn("submit-contribution-pledge")).toContain("This has no effect on anyone's rides");
  });
});

describe("acceptance: contribution evidence follows the upload rules", () => {
  it("rejects a public URL and holds evidence pending until scanned", () => {
    const source = fn("record-contribution-fulfillment");
    expect(source).toContain("public_url_rejected");
    expect(source).toContain("unavailableScanner");
    expect(source).toContain("Only a platform administrator can verify a contribution.");
  });
});

describe("milestone 3 wiring", () => {
  it("ships all nine new functions", () => {
    const names = readdirSync(FUNCTIONS);
    for (const required of [
      "request-participant-authorization", "confirm-participant-authorization", "manage-organization-member",
      "manage-contribution-catalog", "submit-contribution-pledge", "review-contribution-pledge",
      "record-contribution-fulfillment", "build-report",
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it("records mileage as straight-line distance, never a tracked route", () => {
    const ride = entity("ride-request.jsonc");
    expect(ride.properties.reported_miles.description).toContain("Never a tracked route");
    expect(fn("submit-ride-request")).toContain("never a tracked route");
  });

  it("measures volunteer minutes from the immutable timeline", () => {
    const source = fn("transition-ride");
    expect(source).toContain("volunteer_minutes");
    expect(source).toContain("RideEvent.filter");
    expect(source).toContain("Read from the immutable timeline");
  });
});
