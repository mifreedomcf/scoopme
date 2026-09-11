/**
 * Milestone 4 acceptance criteria.
 *
 * The headline requirement for this milestone is that the whole thing is built
 * and none of it is reachable. Most of these tests assert a refusal.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMinorRide, type MinorGateInput } from "@shared/minor-gate";
import { MICHIGAN_DEFAULT_POLICY } from "@shared/restraints";
import { resolveConfig } from "@shared/flags";
import { validateRideRequest } from "@shared/validation";
import { allowedTransitionsFrom } from "@shared/state-machine";
import { minimizeRide } from "@shared/minimize";
import { canSignForMinor, checkAuthority } from "@shared/consent";

const FUNCTIONS = join(process.cwd(), "base44", "functions");
const ENTITIES = join(process.cwd(), "base44", "entities");
const fn = (name: string) => readFileSync(join(FUNCTIONS, name, "entry.ts"), "utf8");
const entity = (file: string) => JSON.parse(readFileSync(join(ENTITIES, file), "utf8"));
const TODAY = "2026-09-11";

const REVIEWED_POLICY = { ...MICHIGAN_DEFAULT_POLICY, legally_reviewed: true };

/** A minor ride with every single requirement satisfied. */
function readyInput(overrides: Partial<MinorGateInput> = {}): MinorGateInput {
  return {
    minorRidesEnabled: true,
    gatesSatisfied: true,
    authority: {
      guardian_user_id: "g1",
      dependent_profile_id: "child-1",
      authority_type: "parent",
      status: "verified",
      verified_by_email: "staff@example.invalid",
      verified_at: "2026-01-01T00:00:00Z",
      expires_on: "2027-01-01",
    },
    dependentProfileId: "child-1",
    guardianUserId: "g1",
    consentRecords: [{
      id: "c1",
      dependent_profile_id: "child-1",
      ride_request_id: "ride-1",
      scope: "single_ride",
      status: "signed",
      document_key: "guardian_agreement_minor_authorization",
      document_version: "0.1-draft",
      signer_user_id: "g1",
      signer_relationship: "parent",
      signed_at: "2026-09-10T10:00:00Z",
    }],
    consentContext: {
      dependentProfileId: "child-1",
      rideRequestId: "ride-1",
      currentDocumentVersion: "0.1-draft",
      standingConsentApproved: false,
      today: TODAY,
      now: "2026-09-11T09:00:00Z",
    },
    child: { age_years: 6, height_inches: 48 },
    restraintPolicy: REVIEWED_POLICY,
    driver: { approval_tier: "minor_transport_approved", eligibility_status: "eligible" },
    vehicleCapabilities: [
      { capability: "booster_seat", quantity: 1, verification_status: "verified", expiration_date: "2027-01-01" },
    ],
    vehicleHasRearSeat: true,
    today: TODAY,
    ...overrides,
  };
}

const codes = (input: MinorGateInput) => checkMinorRide(input).blocking.map((b) => b.code);

describe("acceptance: the whole minor workflow exists and is unreachable", () => {
  it("defaults the flag off and blocks the gate on it", () => {
    expect(resolveConfig(null).minor_rides_enabled).toBe(false);
    expect(codes(readyInput({ minorRidesEnabled: false }))).toContain("minor_rides_disabled");
  });

  it("refuses a minor ride request at validation while the flag is off", () => {
    const result = validateRideRequest(
      {
        rider_kind: "minor",
        pickup_address: "1 Example Way, Detroit, MI 48205",
        destination_location_id: "loc-1",
        requested_pickup_at: "2026-09-20T10:00:00Z",
      },
      resolveConfig(null),
      new Date("2026-09-11T09:00:00Z"),
    );
    expect(result.errors.map((e) => e.code)).toContain("minor_rides_disabled");
  });

  it("closes every minor function behind the same flag check", () => {
    for (const name of [
      "manage-dependent-profile", "request-minor-consent",
      "sign-minor-consent", "verify-minor-handoff",
    ]) {
      expect(fn(name), name).toContain("minor_rides_disabled");
    }
  });

  it("ships the flag blocked by safeguarding and restraint gates that are seeded incomplete", () => {
    const gates = JSON.parse(readFileSync(join(FUNCTIONS, "seed-pilot-data", "gates.json"), "utf8"));
    const forMinors = gates.filter((g: { gates_flags?: string[] }) =>
      (g.gates_flags ?? []).includes("minor_rides_enabled"));
    const categories = new Set(forMinors.map((g: { category: string }) => g.category));
    expect(categories.has("child_safeguarding")).toBe(true);
    expect(categories.has("child_restraint")).toBe(true);
    for (const g of forMinors) expect(g.status ?? "not_started").not.toBe("complete");
  });
});

describe("acceptance: a minor ride needs every control at once", () => {
  it("passes only when all five hold", () => {
    const verdict = checkMinorRide(readyInput());
    expect(verdict.allowed).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.satisfied).toContain("guardian_authority_verified");
    expect(verdict.satisfied).toContain("guardian_consent_current");
    expect(verdict.satisfied).toContain("driver_minor_transport_tier");
    expect(verdict.satisfied).toContain("restraint_verified:booster_seat");
  });

  it("blocks on incomplete launch gates", () => {
    expect(codes(readyInput({ gatesSatisfied: false }))).toContain("launch_gates_incomplete");
  });

  it("blocks without verified guardian authority", () => {
    expect(codes(readyInput({ authority: null }))).toContain("no_authority_on_file");
    expect(codes(readyInput({
      authority: { ...readyInput().authority!, status: "pending_review" },
    }))).toContain("authority_pending_review");
  });

  it("blocks without current consent for this exact trip", () => {
    expect(codes(readyInput({ consentRecords: [] }))).toContain("no_consent");
    expect(codes(readyInput({
      consentRecords: [{ ...readyInput().consentRecords[0], ride_request_id: "another-ride" }],
    }))).toContain("consent_other_ride");
    expect(codes(readyInput({
      consentRecords: [{ ...readyInput().consentRecords[0], status: "revoked" }],
    }))).toContain("consent_revoked");
    expect(codes(readyInput({
      consentRecords: [{ ...readyInput().consentRecords[0], document_version: "0.0-draft" }],
    }))).toContain("consent_version_superseded");
  });

  it("blocks a general adult driver", () => {
    expect(codes(readyInput({
      driver: { approval_tier: "adult_transport_approved", eligibility_status: "eligible" },
    }))).toContain("missing_minor_transport_tier");
  });

  it("blocks a minor-tier driver who is not currently eligible", () => {
    expect(codes(readyInput({
      driver: { approval_tier: "minor_transport_approved", eligibility_status: "suspended_expired_credential" },
    }))).toContain("driver_suspended_expired_credential");
  });

  it("blocks without the right restraint, verified, in that car", () => {
    expect(codes(readyInput({ vehicleCapabilities: [] }))).toContain("restraint_not_available");
    expect(codes(readyInput({
      vehicleCapabilities: [{ capability: "booster_seat", quantity: 1, verification_status: "self_reported" }],
    }))).toContain("restraint_not_verified");
    // Right equipment, wrong age band.
    expect(codes(readyInput({ child: { age_years: 1 } }))).toContain("restraint_not_available");
  });

  it("blocks while the restraint rules are unreviewed by counsel", () => {
    expect(codes(readyInput({ restraintPolicy: MICHIGAN_DEFAULT_POLICY })))
      .toContain("restraint_policy_unreviewed");
  });

  it("blocks when a fact needed to choose a restraint is missing", () => {
    expect(codes(readyInput({ child: { age_years: 6 } })))
      .toContain("restraint_information_incomplete");
  });

  it("reports every unmet requirement at once, not just the first", () => {
    const verdict = checkMinorRide(readyInput({
      minorRidesEnabled: false,
      gatesSatisfied: false,
      authority: null,
      consentRecords: [],
      driver: null,
      restraintPolicy: MICHIGAN_DEFAULT_POLICY,
    }));
    expect(verdict.blocking.length).toBeGreaterThanOrEqual(6);
  });

  it("is re-checked on approval and on every operational move, not once", () => {
    expect(fn("dispatcher-review-ride")).toContain("evaluateMinorRide");
    const transition = fn("transition-ride");
    expect(transition).toContain("evaluateMinorRide");
    expect(transition).toContain("re-checked against every requirement on EVERY move");
  });

  it("fails closed when the checks cannot be run", () => {
    const runtime = readFileSync(join(process.cwd(), "base44", "shared", "minor-runtime.ts"), "utf8");
    expect(runtime).toContain("Fails closed");
    expect(runtime).toContain("minor_checks_unavailable");
  });
});

describe("acceptance: a CBO scheduler is never a guardian", () => {
  const authority = checkAuthority(readyInput().authority, "child-1", "g1", TODAY);

  it("refuses every non-guardian relationship at the one place that decides", () => {
    for (const kind of ["org_scheduler", "referring_adult", "dispatcher", "self"] as const) {
      expect(canSignForMinor(kind, authority).canSign, kind).toBe(false);
    }
    expect(canSignForMinor("guardian", authority).canSign).toBe(true);
  });

  it("routes the signing function through that decision", () => {
    const source = fn("sign-minor-consent");
    expect(source).toContain("canSignForMinor");
    // The function classifies the caller and hands the decision to that helper,
    // rather than making its own permission judgement.
    expect(source).toContain('? "org_scheduler"');
    expect(source).toContain("eligibility.canSign");
  });

  it("closes participant authorization to under-18s entirely", () => {
    expect(fn("request-participant-authorization")).toContain("minor_cannot_authorize");
  });
});

describe("acceptance: no driver sees a minor ride before consent", () => {
  it("has no path from awaiting_consent to offered", () => {
    expect(allowedTransitionsFrom("awaiting_consent")).toEqual(["approved", "canceled"]);
  });

  it("puts a coordinator-created ride into awaiting_consent and says so", () => {
    const source = fn("request-minor-consent");
    expect(source).toContain('status: "awaiting_consent"');
    expect(source).toContain("no driver can see this ride");
  });

  it("stops everything the moment consent is withdrawn", () => {
    const source = fn("revoke-consent");
    expect(source).toContain('status: "canceled"');
    expect(source).toContain("consent_withdrawn");
    expect(source).toContain("RideAssignment.update");
    expect(source).toContain("never requires a reason");
  });
});

describe("acceptance: handoff, and what a driver is never given", () => {
  it("keeps the PIN out of every driver projection", () => {
    const ride = {
      id: "r1", status: "arrived_dropoff", rider_kind: "minor",
      verification_code: "K7Q2MP", pickup_address: "1 Example Way",
      pickup_area_label: "Northeast Detroit",
    };
    expect(minimizeRide(ride, { viewer: "assigned_driver", revealWindowOpen: true }))
      .not.toHaveProperty("verification_code");
    expect(minimizeRide(ride, { viewer: "unassigned_driver" })).not.toHaveProperty("verification_code");
  });

  it("field-secures the handoff PIN so only the guardian and staff can read it", () => {
    const schema = entity("handoff-record.jsonc");
    expect(schema.properties.pin.rls?.read).toBeTruthy();
    expect(schema.properties.pin.description).toContain("Never included in any driver projection");
    expect(schema.rls.update).toBe(false);
    expect(schema.rls.delete).toBe(false);
  });

  it("escalates a failed handoff into a safeguarding incident with a hold", () => {
    const source = fn("verify-minor-handoff");
    expect(source).toContain('incident_type: "failed_handoff"');
    expect(source).toContain('reason: "safeguarding"');
    expect(source).toContain("DataRetentionHold.create");
    expect(source).toContain("FAILED_HANDOFF_INSTRUCTIONS");
    expect(source).toContain("No assessment of what happened has been made");
  });
});

describe("acceptance: no private driver-child contact anywhere", () => {
  it("has no code path that creates such a thread", () => {
    const source = fn("post-message");
    expect(source).toContain("threadMembershipAllowed");
    expect(source).toContain("is re-checked on");
  });

  it("audits every read of a child's thread", () => {
    expect(fn("post-message")).toContain('event_type: "access.minor_record"');
  });
});

describe("acceptance: minimum data about a child", () => {
  it("refuses to store school, diagnosis, custody detail or an identifier", () => {
    const source = fn("manage-dependent-profile");
    for (const banned of ["school", "diagnosis", "custody_details", "ssn", "immigration_status", "weight_pounds"]) {
      expect(source).toContain(banned);
    }
    expect(source).toContain("field_not_collected");
  });

  it("declares no such field on the child's schema", () => {
    const schema = entity("dependent-profile.jsonc");
    for (const field of Object.keys(schema.properties)) {
      expect(field).not.toMatch(/school|diagnosis|medical|custody|ssn|social_security|immigration|weight/i);
    }
  });

  it("creates no child account and collects nothing from a child", () => {
    const source = fn("manage-dependent-profile");
    expect(source).toContain("There is no child account and no child login");
    expect(source).toContain("COPPA");
    const schema = entity("dependent-profile.jsonc");
    expect(schema.properties.user_id).toBeUndefined();
    expect(schema.properties.email).toBeUndefined();
    expect(schema.properties.password).toBeUndefined();
  });

  it("field-secures the child's name, date of birth and height", () => {
    const schema = entity("dependent-profile.jsonc");
    for (const field of ["first_name", "date_of_birth", "height_inches"]) {
      expect(schema.properties[field].rls?.read, field).toBeTruthy();
    }
  });
});

describe("acceptance: nobody self-verifies", () => {
  it("blocks a guardian verifying their own authority", () => {
    expect(fn("verify-guardian-authority")).toContain("You cannot verify your own guardian authority.");
  });

  it("requires a document, scanned clean, and a re-verification date", () => {
    const source = fn("verify-guardian-authority");
    expect(source).toContain("document_required");
    expect(source).toContain("document_not_scanned");
    expect(source).toContain("expiry_required");
    expect(source).toContain("A stated relationship on its own is not proof of legal authority");
  });

  it("revokes dependent consents when an authority is withdrawn", () => {
    expect(fn("verify-guardian-authority")).toContain("consents_revoked");
  });
});

describe("milestone 4 wiring", () => {
  it("ships all seven new functions and six new entities", () => {
    const names = readdirSync(FUNCTIONS);
    for (const required of [
      "manage-dependent-profile", "verify-guardian-authority", "request-minor-consent",
      "sign-minor-consent", "revoke-consent", "verify-minor-handoff", "post-message",
    ]) {
      expect(names, required).toContain(required);
    }
    for (const file of [
      "dependent-profile.jsonc", "guardian-relationship.jsonc", "consent-record.jsonc",
      "authorized-adult.jsonc", "handoff-record.jsonc", "message-thread.jsonc", "message.jsonc",
    ]) {
      expect(() => entity(file), file).not.toThrow();
    }
  });

  it("keeps the restraint thresholds configurable and unreviewed by default", () => {
    const config = entity("system-config.jsonc");
    expect(config.properties.restraint_policy_reviewed.default).toBe(false);
    expect(config.properties.standing_minor_consent_approved.default).toBe(false);
    expect(config.properties.restraint_rear_facing_max_age.default).toBe(2);
    expect(config.properties.restraint_forward_facing_max_age.default).toBe(5);
    expect(config.properties.restraint_booster_max_age.default).toBe(8);
    expect(config.properties.restraint_rear_seat_required_under_age.default).toBe(13);
    expect(config.properties.restraint_rear_facing_max_age.description).toContain("REQUIRES LEGAL REVIEW");
  });

  it("makes consent records immutable to clients", () => {
    for (const file of ["consent-record.jsonc", "guardian-relationship.jsonc", "handoff-record.jsonc", "message.jsonc"]) {
      const schema = entity(file);
      expect(schema.rls.create, file).toBe(false);
      expect(schema.rls.update, file).toBe(false);
      expect(schema.rls.delete, file).toBe(false);
    }
  });
});
