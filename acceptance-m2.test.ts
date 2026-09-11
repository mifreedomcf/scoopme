/**
 * Milestone 2 acceptance criteria, checked against the modules that decide.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeEligibility } from "@shared/eligibility";
import { evaluateRideWatch } from "@shared/escalation";
import { evaluateDriver, REQUIRED_ADULT_CREDENTIALS } from "@shared/matching";
import { mayServeAttachment, scanStatusFor, unavailableScanner } from "@shared/uploads";
import { planDelivery } from "@shared/delivery";
import { minimizeRide } from "@shared/minimize";

const TODAY = "2026-09-09";
const FUNCTIONS = join(process.cwd(), "base44", "functions");
const fn = (name: string) => readFileSync(join(FUNCTIONS, name, "entry.ts"), "utf8");

describe("acceptance: an expired credential suspends eligibility immediately", () => {
  it("flips the driver out of eligible on the day it lapses, and out of matching too", () => {
    const credentials = [
      ...REQUIRED_ADULT_CREDENTIALS.slice(1).map((credential_type) => ({
        credential_type, required_for: "adult_transport" as const, status: "verified", expiration_date: "2027-01-01",
      })),
      {
        credential_type: REQUIRED_ADULT_CREDENTIALS[0],
        required_for: "adult_transport" as const, status: "verified", expiration_date: "2026-09-08",
      },
    ];
    const eligibility = computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials,
      vehicles: [{ id: "v1", status: "active" }],
      today: TODAY,
    });
    expect(eligibility.status).toBe("suspended_expired_credential");

    const match = evaluateDriver(
      {
        driver_profile_id: "d1", approval_tier: "adult_transport_approved",
        eligibility_status: eligibility.status, languages: ["en"], accepts_service_animals: true,
        max_travel_miles: 15, credentials, capabilities: [],
        availability: [{ starts_at: "2026-09-11T08:00:00Z", ends_at: "2026-09-11T18:00:00Z", status: "active" }],
        bookedWindows: [], vehicleSeatingCapacity: 4, vehicleStatus: "active", vehicleInspectionOk: true,
      },
      {
        riderKind: "adult", passengerCount: 1,
        windowStart: "2026-09-11T10:00:00Z", windowEnd: "2026-09-11T11:00:00Z",
        serviceAnimal: false, needs: [], maxVolunteerTravelMiles: 15,
      },
      TODAY,
    );
    expect(match.eligible).toBe(false);
  });

  it("withdraws the suspended driver's open offers in the daily sweep", () => {
    const source = fn("credential-expiry-sweep");
    expect(source).toContain("RideOffer.updateMany");
    expect(source).toContain('status: "withdrawn"');
    expect(source).toContain("driver.eligibility_status === \"eligible\" && result.status !== \"eligible\"");
  });
});

describe("acceptance: a driver cannot verify their own paperwork", () => {
  it("blocks self-review on credentials, vehicles, and applications", () => {
    expect(fn("review-driver-credential")).toContain("You cannot verify your own credentials.");
    expect(fn("review-vehicle")).toContain("You cannot verify your own vehicle.");
    expect(fn("driver-application-review")).toContain("You cannot decide your own application.");
  });

  it("keeps vendor checks off the list a driver can submit", () => {
    const source = fn("submit-driver-credential");
    for (const vendorOnly of ["mvr_check", "criminal_background_check", "sex_offender_registry_check", "fingerprinting", "child_abuse_neglect_registry"]) {
      expect(source.includes(`"${vendorOnly}",`) && source.includes("DRIVER_SUBMITTABLE")).toBe(
        source.split("DRIVER_SUBMITTABLE")[1]?.split("]")[0]?.includes(vendorOnly) ?? false,
      );
    }
    const submittable = source.split("const DRIVER_SUBMITTABLE = [")[1].split("];")[0];
    for (const vendorOnly of ["mvr_check", "criminal_background_check", "sex_offender_registry_check", "fingerprinting", "child_abuse_neglect_registry"]) {
      expect(submittable).not.toContain(vendorOnly);
    }
  });

  it("clears a prior verification when a document is replaced", () => {
    const source = fn("submit-driver-credential");
    expect(source).toContain('verified_by_email: ""');
    expect(source).toContain('status: "submitted"');
  });
});

describe("acceptance: a self-reported accommodation never satisfies an access need", () => {
  it("records a driver's own declaration as unverified and resets it on re-declaration", () => {
    const source = fn("manage-vehicle");
    expect(source).toContain('verification_status: "self_reported"');
    expect(source).not.toContain('verification_status: "verified"');
  });

  it("requires a verified capability in the matcher", () => {
    const base = {
      driver_profile_id: "d1", approval_tier: "adult_transport_approved" as const,
      eligibility_status: "eligible", languages: ["en"], accepts_service_animals: true, max_travel_miles: 15,
      credentials: REQUIRED_ADULT_CREDENTIALS.map((credential_type) => ({
        credential_type, required_for: "adult_transport" as const, status: "verified", expiration_date: "2027-01-01",
      })),
      availability: [{ starts_at: "2026-09-11T08:00:00Z", ends_at: "2026-09-11T18:00:00Z", status: "active" }],
      bookedWindows: [], vehicleSeatingCapacity: 4, vehicleStatus: "active", vehicleInspectionOk: true,
    };
    const ride = {
      riderKind: "adult" as const, passengerCount: 1,
      windowStart: "2026-09-11T10:00:00Z", windowEnd: "2026-09-11T11:00:00Z",
      serviceAnimal: false, maxVolunteerTravelMiles: 15,
      needs: [{ need: "wheelchair_lift", quantity: 1, is_hard_requirement: true }],
    };
    expect(evaluateDriver({ ...base, capabilities: [{ capability: "wheelchair_lift", quantity: 1, verification_status: "self_reported" }] }, ride, TODAY).eligible).toBe(false);
    expect(evaluateDriver({ ...base, capabilities: [{ capability: "wheelchair_lift", quantity: 1, verification_status: "verified" }] }, ride, TODAY).eligible).toBe(true);
  });
});

describe("acceptance: the rider's code is never sent to the driver", () => {
  it("withholds it from every driver projection", () => {
    const ride = {
      id: "r1", status: "arrived_pickup", rider_kind: "adult",
      verification_code: "K7Q2MP", pickup_address: "1 Example Way", contact_phone: "555-0111",
      pickup_area_label: "Northeast Detroit",
    };
    expect(minimizeRide(ride, { viewer: "unassigned_driver" })).not.toHaveProperty("verification_code");
    expect(minimizeRide(ride, { viewer: "assigned_driver", revealWindowOpen: true })).not.toHaveProperty("verification_code");
    expect(minimizeRide(ride, { viewer: "rider" }).verification_code).toBe("K7Q2MP");
  });

  it("compares the typed code server-side, rate limits guesses, and reveals nothing on failure", () => {
    const source = fn("verify-ride-identity");
    expect(source).toContain("safeEqual");
    expect(source).toContain("too_many_attempts");
    expect(source).toContain("identity_code_mismatch");
    // The failure message must not echo the expected value.
    expect(source).not.toMatch(/expected\s*\}/);
  });
});

describe("acceptance: an incident locks the record", () => {
  it("opens a retention hold and freezes the ride before anything else", () => {
    const source = fn("report-safety-incident");
    expect(source).toContain("DataRetentionHold.create");
    expect(source).toContain('status: "incident_hold"');
    expect(source).toContain("retention_hold_active: true");
  });

  it("never claims to have contacted emergency services", () => {
    const source = fn("report-safety-incident");
    expect(source).toContain("This report does not contact emergency services");
  });

  it("requires a mandated report before a safeguarding incident can be closed", () => {
    expect(fn("manage-safety-incident")).toContain("mandated_report_required");
  });

  it("makes releasing a hold a separate, justified, admin-only act", () => {
    const source = fn("manage-safety-incident");
    expect(source).toContain("Only a platform administrator can release a retention hold.");
    expect(source).toContain("justification.trim().length < 40");
    expect(source).toContain("incident_not_closed");
  });
});

describe("acceptance: automated alerts assist people and never decide", () => {
  it("raises an observation, opens an incident for a human, and classifies nothing", () => {
    const source = fn("ride-checkin-sweep");
    expect(source).toContain("No assessment of what happened has been made");
    expect(source).toContain('incident_type: "other"');
    // The sweep must never move a ride to a terminal or cancelled state.
    for (const forbidden of ['to_state: "canceled"', 'status: "canceled"', 'status: "completed"', 'status: "closed_by_admin"']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("only fires once per level", () => {
    const pickup = "2026-09-11T10:00:00Z";
    const late = new Date(new Date(pickup).getTime() + 20 * 60_000);
    expect(evaluateRideWatch({ status: "confirmed", requested_pickup_at: pickup, now: late, escalation_level: 1 }).raise)
      .toBe(false);
  });
});

describe("acceptance: unscanned files are never served", () => {
  it("stores an attachment as pending and marks it not viewable", async () => {
    const scan = await unavailableScanner.scan("private://evidence");
    expect(mayServeAttachment(scanStatusFor(scan.verdict))).toBe(false);
    expect(fn("attach-incident-evidence")).toContain("viewable: scanStatus === \"clean\"");
  });

  it("refuses to verify a credential whose document has not been scanned clean", () => {
    expect(fn("review-driver-credential")).toContain("document_not_scanned");
  });

  it("rejects a public URL wherever a private reference is expected", () => {
    for (const name of ["submit-driver-credential", "manage-vehicle", "attach-incident-evidence"]) {
      expect(fn(name)).toContain("public_url_rejected");
    }
  });
});

describe("acceptance: notifications never claim a delivery that did not happen", () => {
  it("suppresses with a reason instead of marking sent", () => {
    const plan = planDelivery(
      {
        id: "n1", channel: "email", template_key: "request_approved",
        idempotency_key: "k", recipient_email: "a@example.invalid", status: "queued",
      },
      {
        now: new Date(), alreadySent: new Set(), perRecipientLimit: 10, recentToRecipient: 0,
        providerLive: { email: false, sms: false, in_app: true },
      },
    );
    expect(plan).toMatchObject({ action: "skip", code: "suppressed_provider_missing" });
    expect(fn("dispatch-notifications")).toContain("redaction_check_failed");
  });
});

describe("acceptance: the outage manifest is guarded and audited", () => {
  it("requires a staff role, a written purpose, a bounded range, and logs the export", () => {
    const source = fn("export-ride-manifest");
    expect(source).toContain("purpose_required");
    expect(source).toContain("range_too_wide");
    expect(source).toContain('event_type: "export.sensitive"');
    expect(source).toContain("shred it at the end of the day");
  });
});

describe("scheduled automations", () => {
  const configs = readdirSync(FUNCTIONS)
    .filter((name) => {
      try { readFileSync(join(FUNCTIONS, name, "function.jsonc"), "utf8"); return true; } catch { return false; }
    })
    .map((name) => ({ name, raw: readFileSync(join(FUNCTIONS, name, "function.jsonc"), "utf8") }));

  it("ships the three sweeps with valid automation configuration", () => {
    expect(configs.map((c) => c.name).sort()).toEqual([
      "credential-expiry-sweep", "dispatch-notifications", "ride-checkin-sweep",
    ]);
    for (const { raw } of configs) {
      const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
      expect(json.entry).toBe("entry.ts");
      expect(Array.isArray(json.automations)).toBe(true);
      for (const a of json.automations) {
        expect(a.type).toBe("scheduled");
        expect(a.schedule_mode).toBe("recurring");
        expect(["cron", "simple"]).toContain(a.schedule_type);
        if (a.schedule_type === "cron") expect(a.cron_expression.split(" ")).toHaveLength(5);
        if (a.schedule_type === "simple") expect(a.repeat_unit).toBeTruthy();
      }
    }
  });
});
