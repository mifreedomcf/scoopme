import { describe, expect, it } from "vitest";
import { addDays, computeEligibility, EXPIRY_NOTICE_DAYS, inspectionRequired } from "@shared/eligibility";
import { REQUIRED_ADULT_CREDENTIALS, REQUIRED_MINOR_CREDENTIALS } from "@shared/matching";

const TODAY = "2026-09-09";

function creds(types: string[], expiration = "2027-06-01", status = "verified") {
  return types.map((credential_type) => ({
    credential_type,
    required_for: "adult_transport" as const,
    status,
    expiration_date: expiration,
  }));
}

const goodVehicle = [{ id: "v1", status: "active", inspection_required: false, seating_capacity: 4 }];

describe("driver eligibility", () => {
  it("clears a driver with every required credential current and an active vehicle", () => {
    const result = computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(result.status).toBe("eligible");
    expect(result.blocking).toEqual([]);
  });

  it("suspends the moment a verified credential passes its date", () => {
    const result = computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: [
        ...creds(REQUIRED_ADULT_CREDENTIALS.slice(1)),
        ...creds([REQUIRED_ADULT_CREDENTIALS[0]], "2026-09-08"),
      ],
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(result.status).toBe("suspended_expired_credential");
    expect(result.reason_code).toBe("credential_expired");
    expect(result.blocking).toContain(REQUIRED_ADULT_CREDENTIALS[0]);
  });

  it("distinguishes never-completed from lapsed", () => {
    const never = computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS.slice(1)),
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(never.status).toBe("ineligible");
    expect(never.reason_code).toBe("credentials_incomplete");
  });

  it("requires the extra minor checks for the minor-transport tier", () => {
    const result = computeEligibility({
      approval_tier: "minor_transport_approved",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(result.status).toBe("ineligible");
    for (const c of REQUIRED_MINOR_CREDENTIALS) expect(result.blocking).toContain(c);
  });

  it("never lets a passing credential check clear an administrative suspension", () => {
    const result = computeEligibility({
      approval_tier: "adult_transport_approved",
      admin_suspended: true,
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(result.status).toBe("suspended_admin");
  });

  it("puts an incident hold above everything else", () => {
    const result = computeEligibility({
      approval_tier: "adult_transport_approved",
      admin_suspended: true,
      on_incident_hold: true,
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(result.status).toBe("on_incident_hold");
  });

  it("blocks a driver with no active vehicle, and one whose inspection lapsed", () => {
    expect(computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: [{ id: "v1", status: "pending_review" }],
      today: TODAY,
    }).reason_code).toBe("no_active_vehicle");

    expect(computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: [{ id: "v1", status: "active", inspection_required: true, inspection_status: "passed", inspection_expiration: "2026-08-01" }],
      today: TODAY,
    }).reason_code).toBe("vehicle_inspection_not_current");
  });

  it("warns about documents inside the notice window and not outside it", () => {
    const result = computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: [
        ...creds(REQUIRED_ADULT_CREDENTIALS.slice(1)),
        ...creds([REQUIRED_ADULT_CREDENTIALS[0]], addDays(TODAY, 10)),
      ],
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(result.status).toBe("eligible");
    expect(result.expiring_soon.map((e) => e.credential_type)).toContain(REQUIRED_ADULT_CREDENTIALS[0]);

    const far = computeEligibility({
      approval_tier: "adult_transport_approved",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS, addDays(TODAY, EXPIRY_NOTICE_DAYS + 5)),
      vehicles: goodVehicle,
      today: TODAY,
    });
    expect(far.expiring_soon).toEqual([]);
  });

  it("computes the inspection threshold from the vehicle year", () => {
    expect(inspectionRequired(2021, 5, TODAY)).toBe(true);
    expect(inspectionRequired(2022, 5, TODAY)).toBe(false);
  });

  it("treats an unapproved driver as ineligible whatever their paperwork says", () => {
    expect(computeEligibility({
      approval_tier: "none",
      credentials: creds(REQUIRED_ADULT_CREDENTIALS),
      vehicles: goodVehicle,
      today: TODAY,
    }).status).toBe("ineligible");
  });
});
