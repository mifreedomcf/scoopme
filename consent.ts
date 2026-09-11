/**
 * Guardian authority and minor-transport consent. Pure module.
 *
 * Two separate things, deliberately kept apart:
 *
 *   AUTHORITY  — is this adult legally entitled to decide for this child?
 *                Verified once, by a person, against a document.
 *   CONSENT    — has that adult actually agreed to THIS trip, on THIS version
 *                of the wording?
 *
 * Having the first never implies the second, and no amount of professional
 * relationship produces either. An organization scheduler cannot supply either
 * one, whatever else they are authorized to do.
 */

export type AuthorityType =
  | "parent"
  | "legal_guardian"
  | "court_appointed_custodian"
  | "documented_delegated_authority";

export type AuthorityStatus = "unverified" | "pending_review" | "verified" | "rejected" | "expired" | "revoked";

export interface GuardianAuthority {
  guardian_user_id: string;
  dependent_profile_id: string;
  authority_type: AuthorityType;
  status: AuthorityStatus;
  verified_by_email?: string;
  verified_at?: string;
  expires_on?: string;
  /** Private storage reference. Never a URL, never the document contents. */
  document_reference?: string;
}

export interface AuthorityCheck {
  ok: boolean;
  code: string;
  message: string;
}

/** Is this adult currently entitled to decide for this child? */
export function checkAuthority(
  authority: GuardianAuthority | null | undefined,
  dependentProfileId: string,
  actingUserId: string,
  today: string,
): AuthorityCheck {
  if (!authority) {
    return { ok: false, code: "no_authority_on_file", message: "No verified parent or legal guardian is recorded for this child." };
  }
  if (authority.dependent_profile_id !== dependentProfileId) {
    return { ok: false, code: "authority_other_child", message: "That authority is for a different child." };
  }
  if (authority.guardian_user_id !== actingUserId) {
    return { ok: false, code: "not_the_guardian", message: "You are not the recorded guardian for this child." };
  }
  if (authority.status !== "verified") {
    return { ok: false, code: `authority_${authority.status}`, message: "This guardian's authority has not been verified by a coordinator." };
  }
  if (authority.expires_on && authority.expires_on < today) {
    return { ok: false, code: "authority_expired", message: "This guardian's authority needs re-verifying." };
  }
  if (!authority.verified_by_email || !authority.verified_at) {
    return { ok: false, code: "authority_unattested", message: "No coordinator is recorded as having verified this." };
  }
  return { ok: true, code: "authority_verified", message: `Verified ${authority.authority_type.replace(/_/g, " ")}.` };
}

export type ConsentScope = "single_ride" | "standing";
export type ConsentStatus = "requested" | "signed" | "revoked" | "expired" | "superseded";

export interface ConsentRecordSnapshot {
  id: string;
  dependent_profile_id: string;
  ride_request_id?: string;
  scope: ConsentScope;
  status: ConsentStatus;
  document_key: string;
  document_version: string;
  signer_user_id?: string;
  signer_relationship?: string;
  signed_at?: string;
  starts_on?: string;
  expires_on?: string;
  revoked_at?: string;
}

export interface ConsentContext {
  dependentProfileId: string;
  rideRequestId: string;
  /** The version currently published and required. */
  currentDocumentVersion: string;
  /** Standing consent is only offered once counsel has approved its wording. */
  standingConsentApproved: boolean;
  today: string;
  now: string;
}

export interface ConsentCheck {
  ok: boolean;
  code: string;
  message: string;
  consent_id?: string;
}

/**
 * Is there a live, correctly scoped, current-version consent covering this
 * exact child on this exact ride?
 */
export function checkConsent(
  records: ConsentRecordSnapshot[],
  ctx: ConsentContext,
): ConsentCheck {
  const forChild = records.filter((c) => c.dependent_profile_id === ctx.dependentProfileId);
  if (forChild.length === 0) {
    return { ok: false, code: "no_consent", message: "No guardian consent has been given for this child." };
  }

  const candidates = forChild.filter((c) => {
    if (c.status !== "signed") return false;
    if (c.revoked_at) return false;
    if (c.scope === "single_ride") return c.ride_request_id === ctx.rideRequestId;
    if (c.scope === "standing") {
      if (!ctx.standingConsentApproved) return false;
      if (c.starts_on && c.starts_on > ctx.today) return false;
      if (!c.expires_on) return false; // standing consent must be time-limited
      return c.expires_on >= ctx.today;
    }
    return false;
  });

  if (candidates.length === 0) {
    const revoked = forChild.some((c) => c.status === "revoked" || c.revoked_at);
    if (revoked) {
      return { ok: false, code: "consent_revoked", message: "Consent for this child has been withdrawn." };
    }
    const expired = forChild.some((c) => c.status === "expired" || (c.expires_on && c.expires_on < ctx.today));
    if (expired) {
      return { ok: false, code: "consent_expired", message: "Consent for this child has expired and needs signing again." };
    }
    const wrongRide = forChild.some((c) => c.scope === "single_ride" && c.ride_request_id !== ctx.rideRequestId);
    if (wrongRide) {
      return {
        ok: false,
        code: "consent_other_ride",
        message: "The consent on file is for a different trip. Each trip needs its own, unless a time-limited standing consent is in place.",
      };
    }
    return { ok: false, code: "no_signed_consent", message: "Consent has been asked for but not signed." };
  }

  // The version matters: agreeing to older wording is not agreeing to this one.
  const current = candidates.find((c) => c.document_version === ctx.currentDocumentVersion);
  if (!current) {
    return {
      ok: false,
      code: "consent_version_superseded",
      message: "The wording has changed since this was signed. The guardian needs to read and sign the current version.",
    };
  }
  if (!current.signer_user_id || !current.signed_at) {
    return { ok: false, code: "consent_unattributed", message: "This consent has no recorded signer." };
  }

  return { ok: true, code: "consent_valid", message: "Current guardian consent is on file.", consent_id: current.id };
}

export type RequesterKind = "self" | "guardian" | "org_scheduler" | "dispatcher" | "referring_adult";

export interface ConsentEligibility {
  canSign: boolean;
  code: string;
  message: string;
}

/**
 * Who may sign for a child.
 *
 * A teacher, doctor, case manager, coach or nonprofit worker may help arrange a
 * trip. None of them may sign. This function is the one place that decides, and
 * it says no to every relationship except verified legal authority.
 */
export function canSignForMinor(kind: RequesterKind, authority: AuthorityCheck): ConsentEligibility {
  if (kind === "org_scheduler") {
    return {
      canSign: false,
      code: "scheduler_cannot_consent",
      message:
        "An organization scheduler cannot give consent for a child. A verified parent or legal guardian has to sign, separately.",
    };
  }
  if (kind === "referring_adult") {
    return {
      canSign: false,
      code: "referring_adult_cannot_consent",
      message:
        "Referring a child does not make someone their guardian. A verified parent or legal guardian has to sign.",
    };
  }
  if (kind === "dispatcher" || kind === "self") {
    return {
      canSign: false,
      code: "not_a_guardian",
      message: "Only a verified parent or legal guardian can sign for a child.",
    };
  }
  if (!authority.ok) {
    return { canSign: false, code: authority.code, message: authority.message };
  }
  return { canSign: true, code: "may_sign", message: "Verified guardian may sign." };
}

/** What we record at signing time. Enough to prove who agreed to what, and no more. */
export interface ConsentAttestation {
  document_key: string;
  document_version: string;
  signer_user_id: string;
  signer_relationship: string;
  signed_at: string;
  /** Truncated to /24 where lawful. Optional. */
  request_ip?: string;
  user_agent?: string;
  dependent_profile_id: string;
  ride_request_id?: string;
  scope: ConsentScope;
  expires_on?: string;
}

export function validateAttestation(a: Partial<ConsentAttestation>, standingApproved: boolean): {
  ok: boolean;
  errors: { field: string; code: string; message: string }[];
} {
  const errors: { field: string; code: string; message: string }[] = [];
  const need = (field: keyof ConsentAttestation, message: string) => {
    if (!a[field]) errors.push({ field: String(field), code: "required", message });
  };
  need("document_key", "The consent wording has to be recorded.");
  need("document_version", "The exact version signed has to be recorded.");
  need("signer_user_id", "We have to record who signed.");
  need("signer_relationship", "We have to record their relationship to the child.");
  need("signed_at", "We have to record when it was signed.");
  need("dependent_profile_id", "We have to record which child this covers.");

  if (a.scope === "single_ride" && !a.ride_request_id) {
    errors.push({ field: "ride_request_id", code: "required", message: "A single-trip consent has to name the trip it covers." });
  }
  if (a.scope === "standing") {
    if (!standingApproved) {
      errors.push({
        field: "scope",
        code: "standing_not_approved",
        message: "Standing consent is not available until counsel has approved its wording.",
      });
    }
    if (!a.expires_on) {
      errors.push({ field: "expires_on", code: "required", message: "Standing consent has to be time limited." });
    }
  }
  return { ok: errors.length === 0, errors };
}
