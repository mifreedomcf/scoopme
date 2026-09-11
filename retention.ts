/**
 * Retention, deletion and anonymization. Pure module.
 *
 * Two rules govern everything here. Data that has served its purpose goes away
 * on a schedule, without anyone remembering to do it. And a legal, audit,
 * insurance, tax, safeguarding or incident hold beats the schedule every time —
 * the sweep skips held records rather than deleting them, and when the hold
 * table cannot be read, nothing is deleted at all.
 */

export type RetentionAction = "delete" | "anonymize" | "keep";

export interface RetentionRule {
  entity: string;
  /** Days after the anchor date before the action runs. */
  retain_days: number;
  action: RetentionAction;
  /** Which timestamp the clock runs from. */
  anchor_field: string;
  /** Fields blanked when anonymizing. The row survives for counting. */
  anonymize_fields?: string[];
  note: string;
}

/**
 * Default schedule. Every figure is admin-configurable and every one of them is
 * a guess until the privacy review sets it deliberately — that review is the
 * `privacy_security` launch gate.
 */
export const DEFAULT_RETENTION_RULES: RetentionRule[] = [
  {
    entity: "LocationEvent",
    retain_days: 7,
    action: "delete",
    anchor_field: "recorded_at",
    note: "Precise location is the most sensitive thing here and the least useful later. It goes first.",
  },
  {
    entity: "TrackingLink",
    retain_days: 30,
    action: "delete",
    anchor_field: "expires_at",
    note: "Expired tokens are kept briefly so an access question can be answered, then removed.",
  },
  {
    entity: "Message",
    retain_days: 180,
    action: "delete",
    anchor_field: "sent_at",
    note: "Coordination chatter. Incident-related threads are held separately.",
  },
  {
    entity: "RideRequest",
    retain_days: 730,
    action: "anonymize",
    anchor_field: "completed_at",
    anonymize_fields: [
      "pickup_address", "destination_address", "pickup_latitude", "pickup_longitude",
      "destination_latitude", "destination_longitude", "contact_phone",
      "operational_notes", "verification_code", "rider_user_id", "requested_by_user_id",
    ],
    note: "The ride is kept for counting; everything that identifies who took it is removed.",
  },
  {
    entity: "Notification",
    retain_days: 90,
    action: "delete",
    anchor_field: "queued_at",
    note: "Delivery records age out once nobody is chasing a message.",
  },
  {
    entity: "HandoffRecord",
    retain_days: 365,
    action: "anonymize",
    anchor_field: "verified_at",
    anonymize_fields: ["pin", "verified_adult_id", "expected_adult_ids"],
    note: "A handoff is kept as an event; the PIN and the named adults are removed.",
  },
  {
    entity: "SafetyIncident",
    retain_days: 2555,
    action: "keep",
    anchor_field: "occurred_at",
    note: "Safeguarding records are kept. Deletion is a decision a person makes, never a job.",
  },
  {
    entity: "AuditLog",
    retain_days: 2555,
    action: "keep",
    anchor_field: "occurred_at",
    note: "The audit trail is the thing that proves what happened. It is never swept.",
  },
  {
    entity: "ConsentRecord",
    retain_days: 2555,
    action: "keep",
    anchor_field: "signed_at",
    note: "Proof of who agreed to what has to outlive the trip it covered.",
  },
];

/** Entities the sweep will never touch, whatever a rule says. */
export const NEVER_SWEPT = ["AuditLog", "SafetyIncident", "ConsentRecord", "LegalAcceptance", "DataRetentionHold"];

export interface HoldSnapshot {
  scope_entity: string;
  /** Blank means the whole entity is held. */
  scope_id?: string;
  is_active: boolean;
}

export interface SweepCandidate {
  entity: string;
  id: string;
  /** Value of the rule's anchor field. */
  anchor_value?: string;
}

export interface SweepDecision {
  action: RetentionAction;
  code: string;
  message: string;
  anonymize_fields?: string[];
}

/**
 * Decide what happens to one record.
 *
 * Fails closed in every direction: no rule, no anchor date, an unreadable hold
 * table, or a protected entity all produce `keep`.
 */
export function decideSweep(
  candidate: SweepCandidate,
  rules: RetentionRule[],
  holds: HoldSnapshot[] | null,
  today: string,
): SweepDecision {
  if (NEVER_SWEPT.includes(candidate.entity)) {
    return { action: "keep", code: "never_swept", message: "This record type is never removed by a job." };
  }
  if (holds === null) {
    // We could not read the hold table. Deleting now could destroy evidence.
    return { action: "keep", code: "holds_unreadable", message: "Could not confirm holds, so nothing was removed." };
  }

  const held = holds.some(
    (h) => h.is_active && h.scope_entity === candidate.entity && (!h.scope_id || h.scope_id === candidate.id),
  );
  if (held) {
    return { action: "keep", code: "under_hold", message: "A legal, incident or audit hold covers this record." };
  }

  const rule = rules.find((r) => r.entity === candidate.entity);
  if (!rule) {
    return { action: "keep", code: "no_rule", message: "No retention rule covers this record type." };
  }
  if (rule.action === "keep") {
    return { action: "keep", code: "rule_keep", message: rule.note };
  }
  if (!candidate.anchor_value) {
    return { action: "keep", code: "no_anchor_date", message: "This record has no date to measure from yet." };
  }

  const anchor = new Date(candidate.anchor_value).getTime();
  if (!Number.isFinite(anchor)) {
    return { action: "keep", code: "bad_anchor_date", message: "This record's date could not be read." };
  }
  const ageDays = (new Date(`${today}T00:00:00Z`).getTime() - anchor) / 86_400_000;
  if (ageDays < rule.retain_days) {
    return { action: "keep", code: "within_retention", message: `Kept for another ${Math.ceil(rule.retain_days - ageDays)} days.` };
  }

  return {
    action: rule.action,
    code: rule.action === "delete" ? "past_retention_delete" : "past_retention_anonymize",
    message: rule.note,
    anonymize_fields: rule.anonymize_fields,
  };
}

/** Build the patch that strips identity from a record while keeping the row. */
export function anonymizationPatch(fields: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    if (/latitude|longitude|_cents|_minutes|_miles/.test(field)) patch[field] = null;
    else patch[field] = "";
  }
  patch.anonymized_at = new Date().toISOString();
  return patch;
}

/** Merge admin overrides over the defaults, keeping unknown entities out. */
export function rulesFromConfig(overrides: Record<string, number> | undefined): RetentionRule[] {
  if (!overrides) return DEFAULT_RETENTION_RULES;
  return DEFAULT_RETENTION_RULES.map((rule) => {
    const override = overrides[rule.entity];
    if (typeof override !== "number" || !Number.isFinite(override) || override < 0) return rule;
    return { ...rule, retain_days: Math.round(override) };
  });
}
