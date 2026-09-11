import { describe, expect, it } from "vitest";
import {
  canSignForMinor, checkAuthority, checkConsent, validateAttestation,
  type ConsentContext, type ConsentRecordSnapshot, type GuardianAuthority,
} from "@shared/consent";

const TODAY = "2026-09-10";
const NOW = "2026-09-10T09:00:00Z";

const authority: GuardianAuthority = {
  guardian_user_id: "g1",
  dependent_profile_id: "child-1",
  authority_type: "parent",
  status: "verified",
  verified_by_email: "staff@example.invalid",
  verified_at: "2026-01-01T00:00:00Z",
  expires_on: "2027-01-01",
};

function ctx(overrides: Partial<ConsentContext> = {}): ConsentContext {
  return {
    dependentProfileId: "child-1",
    rideRequestId: "ride-1",
    currentDocumentVersion: "0.1-draft",
    standingConsentApproved: false,
    today: TODAY,
    now: NOW,
    ...overrides,
  };
}

function signed(overrides: Partial<ConsentRecordSnapshot> = {}): ConsentRecordSnapshot {
  return {
    id: "c1",
    dependent_profile_id: "child-1",
    ride_request_id: "ride-1",
    scope: "single_ride",
    status: "signed",
    document_key: "guardian_agreement_minor_authorization",
    document_version: "0.1-draft",
    signer_user_id: "g1",
    signer_relationship: "parent",
    signed_at: "2026-09-09T12:00:00Z",
    ...overrides,
  };
}

describe("guardian authority", () => {
  it("accepts a verified, unexpired, attested authority", () => {
    expect(checkAuthority(authority, "child-1", "g1", TODAY).ok).toBe(true);
  });

  it("refuses when there is nothing on file", () => {
    expect(checkAuthority(null, "child-1", "g1", TODAY).code).toBe("no_authority_on_file");
  });

  it("refuses an authority for a different child or a different adult", () => {
    expect(checkAuthority(authority, "child-2", "g1", TODAY).code).toBe("authority_other_child");
    expect(checkAuthority(authority, "child-1", "someone-else", TODAY).code).toBe("not_the_guardian");
  });

  it("refuses an unverified, rejected, revoked or expired authority", () => {
    for (const status of ["unverified", "pending_review", "rejected", "revoked"] as const) {
      expect(checkAuthority({ ...authority, status }, "child-1", "g1", TODAY).ok).toBe(false);
    }
    expect(checkAuthority({ ...authority, expires_on: "2026-08-01" }, "child-1", "g1", TODAY).code)
      .toBe("authority_expired");
  });

  it("refuses an authority marked verified with nobody recorded as verifying it", () => {
    expect(checkAuthority({ ...authority, verified_by_email: undefined }, "child-1", "g1", TODAY).code)
      .toBe("authority_unattested");
  });
});

describe("who may sign for a child", () => {
  const ok = checkAuthority(authority, "child-1", "g1", TODAY);

  it("lets a verified guardian sign", () => {
    expect(canSignForMinor("guardian", ok).canSign).toBe(true);
  });

  it("refuses an organization scheduler, whatever else they are authorized for", () => {
    const r = canSignForMinor("org_scheduler", ok);
    expect(r.canSign).toBe(false);
    expect(r.code).toBe("scheduler_cannot_consent");
    expect(r.message).toContain("verified parent or legal guardian");
  });

  it("refuses a referring adult — a teacher, doctor, case manager or coach", () => {
    const r = canSignForMinor("referring_adult", ok);
    expect(r.canSign).toBe(false);
    expect(r.code).toBe("referring_adult_cannot_consent");
  });

  it("refuses a dispatcher and refuses self-signature", () => {
    expect(canSignForMinor("dispatcher", ok).canSign).toBe(false);
    expect(canSignForMinor("self", ok).canSign).toBe(false);
  });

  it("refuses a guardian whose authority has lapsed", () => {
    const lapsed = checkAuthority({ ...authority, expires_on: "2026-01-01" }, "child-1", "g1", TODAY);
    const r = canSignForMinor("guardian", lapsed);
    expect(r.canSign).toBe(false);
    expect(r.code).toBe("authority_expired");
  });
});

describe("is there live consent for this exact trip", () => {
  it("accepts a signed, current-version, correctly scoped consent", () => {
    const r = checkConsent([signed()], ctx());
    expect(r.ok).toBe(true);
    expect(r.consent_id).toBe("c1");
  });

  it("refuses when nothing has been signed", () => {
    expect(checkConsent([], ctx()).code).toBe("no_consent");
    expect(checkConsent([signed({ status: "requested" })], ctx()).code).toBe("no_signed_consent");
  });

  it("refuses consent given for a different trip", () => {
    expect(checkConsent([signed({ ride_request_id: "ride-2" })], ctx()).code).toBe("consent_other_ride");
  });

  it("refuses consent for a different child", () => {
    expect(checkConsent([signed({ dependent_profile_id: "child-2" })], ctx()).code).toBe("no_consent");
  });

  it("refuses a withdrawn consent immediately", () => {
    expect(checkConsent([signed({ status: "revoked" })], ctx()).code).toBe("consent_revoked");
    expect(checkConsent([signed({ revoked_at: "2026-09-10T08:00:00Z" })], ctx()).code).toBe("consent_revoked");
  });

  it("refuses an older wording version", () => {
    const r = checkConsent([signed({ document_version: "0.0-draft" })], ctx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("consent_version_superseded");
  });

  it("ignores standing consent until counsel has approved the wording", () => {
    const standing = signed({ scope: "standing", ride_request_id: undefined, expires_on: "2026-12-01" });
    expect(checkConsent([standing], ctx({ standingConsentApproved: false })).ok).toBe(false);
    expect(checkConsent([standing], ctx({ standingConsentApproved: true })).ok).toBe(true);
  });

  it("refuses open-ended standing consent even once approved", () => {
    const openEnded = signed({ scope: "standing", ride_request_id: undefined, expires_on: undefined });
    expect(checkConsent([openEnded], ctx({ standingConsentApproved: true })).ok).toBe(false);
  });

  it("refuses expired standing consent", () => {
    const expired = signed({ scope: "standing", ride_request_id: undefined, expires_on: "2026-08-01" });
    expect(checkConsent([expired], ctx({ standingConsentApproved: true })).code).toBe("consent_expired");
  });

  it("refuses a consent with no recorded signer", () => {
    expect(checkConsent([signed({ signer_user_id: undefined })], ctx()).code).toBe("consent_unattributed");
  });
});

describe("what gets recorded at signing", () => {
  const base = {
    document_key: "guardian_agreement_minor_authorization",
    document_version: "0.1-draft",
    signer_user_id: "g1",
    signer_relationship: "parent",
    signed_at: NOW,
    dependent_profile_id: "child-1",
    ride_request_id: "ride-1",
    scope: "single_ride" as const,
  };

  it("accepts a complete single-trip attestation", () => {
    expect(validateAttestation(base, false).ok).toBe(true);
  });

  it("insists on who signed, what they signed, when, and for which child", () => {
    for (const field of ["document_version", "signer_user_id", "signer_relationship", "signed_at", "dependent_profile_id"]) {
      const partial = { ...base, [field]: undefined };
      expect(validateAttestation(partial, false).ok, field).toBe(false);
    }
  });

  it("insists a single-trip consent names its trip", () => {
    expect(validateAttestation({ ...base, ride_request_id: undefined }, false).errors[0].field)
      .toBe("ride_request_id");
  });

  it("refuses standing consent that is unapproved or open-ended", () => {
    const standing = { ...base, scope: "standing" as const, ride_request_id: undefined };
    expect(validateAttestation(standing, false).errors.map((e) => e.code)).toContain("standing_not_approved");
    expect(validateAttestation(standing, true).errors.map((e) => e.field)).toContain("expires_on");
    expect(validateAttestation({ ...standing, expires_on: "2026-12-01" }, true).ok).toBe(true);
  });
});
