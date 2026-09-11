/**
 * Organization contributions: volunteer hours and requested supplies. Pure module.
 *
 * The whole point of this module is a negative guarantee. A pledge, its status,
 * its size, and whether it was ever honoured have no path to a ride decision.
 * There are no balances, no debts, no penalties and no priority. The functions
 * below deliberately expose nothing that a matcher or an eligibility check could
 * consume, and `contributionAffectsRideAccess()` exists so a test can assert
 * that in one line.
 */

export type ContributionKind = "volunteer_hours" | "supplies" | "equipment" | "space" | "services";
export type PledgeStatus = "draft" | "submitted" | "accepted" | "declined" | "withdrawn" | "fulfilled" | "partially_fulfilled" | "lapsed";

export interface CatalogItem {
  id: string;
  kind: ContributionKind;
  title: string;
  /** What the platform actually needs, in the partner's own words. */
  description?: string;
  unit_label: string;
  /** What the operator would like, not what anyone owes. */
  target_quantity?: number;
  active: boolean;
}

export interface PledgeInput {
  catalog_item_id: string;
  quantity: number;
  /** Free text from the organization. Never a condition on anyone's ride. */
  note?: string;
  starts_on?: string;
  ends_on?: string;
}

export interface PledgeValidation {
  ok: boolean;
  errors: { field: string; code: string; message: string }[];
  warnings: string[];
}

const MAX_HOURS_PLEDGE = 2000;
const MAX_UNITS_PLEDGE = 100_000;

/**
 * Language we refuse to record on a pledge, because a pledge that reads as a
 * condition on someone's access is not a pledge.
 */
const CONDITIONAL_PHRASES = [
  "in exchange for",
  "in return for",
  "on condition",
  "conditional on",
  "provided that they",
  "must work",
  "must volunteer",
  "required to volunteer",
  "in lieu of payment",
  "to earn their",
  "so they can get a ride",
  "priority for",
];

export function validatePledge(input: PledgeInput, item: CatalogItem | null, today: string): PledgeValidation {
  const errors: PledgeValidation["errors"] = [];
  const warnings: string[] = [];

  if (!item) {
    errors.push({ field: "catalog_item_id", code: "unknown_item", message: "Choose something from the current list of needs." });
  } else if (!item.active) {
    errors.push({ field: "catalog_item_id", code: "item_inactive", message: "That is no longer something we need. Pick another." });
  }

  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    errors.push({ field: "quantity", code: "invalid_quantity", message: "Enter how much you can offer." });
  } else if (item?.kind === "volunteer_hours" && qty > MAX_HOURS_PLEDGE) {
    errors.push({ field: "quantity", code: "implausible_quantity", message: "That is a very large pledge. Talk to a coordinator instead." });
  } else if (item && item.kind !== "volunteer_hours" && qty > MAX_UNITS_PLEDGE) {
    errors.push({ field: "quantity", code: "implausible_quantity", message: "That is a very large pledge. Talk to a coordinator instead." });
  }

  if (input.starts_on && input.ends_on && input.ends_on < input.starts_on) {
    errors.push({ field: "ends_on", code: "end_before_start", message: "The end date has to be after the start." });
  }
  if (input.ends_on && input.ends_on < today) {
    errors.push({ field: "ends_on", code: "in_the_past", message: "That window has already passed." });
  }

  const note = (input.note ?? "").toLowerCase();
  const conditional = CONDITIONAL_PHRASES.find((phrase) => note.includes(phrase));
  if (conditional) {
    errors.push({
      field: "note",
      code: "conditional_language",
      message:
        "A pledge cannot be tied to anyone getting a ride. Rides are free and unconditional, so please reword this without linking it to a participant's access.",
    });
  }

  if (item && item.target_quantity && qty > item.target_quantity * 3) {
    warnings.push("That is well above what we asked for. A coordinator will get in touch to check it is workable.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface FulfillmentRecord {
  pledge_id: string;
  quantity: number;
  occurred_on: string;
  /** Private storage reference, not a URL. */
  evidence_reference?: string;
  verified: boolean;
}

export interface FulfillmentSummary {
  pledged: number;
  fulfilled: number;
  verified: number;
  outstanding: number;
  status: PledgeStatus;
  /** Stated in the response so no caller has to infer it. */
  consequences_of_shortfall: string;
}

/**
 * Summarise a pledge against what actually arrived.
 *
 * An unmet pledge produces a status and nothing else: no debt, no negative
 * balance, no penalty, no effect on any participant.
 */
export function summariseFulfillment(
  pledgedQuantity: number,
  records: FulfillmentRecord[],
  currentStatus: PledgeStatus,
  today: string,
  endsOn?: string,
): FulfillmentSummary {
  const fulfilled = records.reduce((n, r) => n + (Number(r.quantity) || 0), 0);
  const verified = records.filter((r) => r.verified).reduce((n, r) => n + (Number(r.quantity) || 0), 0);
  const outstanding = Math.max(0, pledgedQuantity - fulfilled);

  let status: PledgeStatus = currentStatus;
  if (currentStatus === "accepted") {
    if (fulfilled >= pledgedQuantity && pledgedQuantity > 0) status = "fulfilled";
    else if (fulfilled > 0) status = "partially_fulfilled";
    if (endsOn && endsOn < today && fulfilled < pledgedQuantity) status = "lapsed";
  }

  return {
    pledged: pledgedQuantity,
    fulfilled,
    verified,
    // Deliberately floored at zero. There is no such thing as owing us hours.
    outstanding,
    status,
    consequences_of_shortfall:
      "None. An unfulfilled pledge creates no debt, no penalty, and no restriction on any participant's rides.",
  };
}

/**
 * The guarantee, as executable code. Nothing about contributions may ever
 * influence ride access, and this function is what a test points at.
 */
export function contributionAffectsRideAccess(): false {
  return false;
}
