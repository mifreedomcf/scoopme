/**
 * Feature-flag resolution and launch-gate enforcement. Pure module.
 *
 * The UI reads flags to decide what to render. The server reads them to decide
 * what to allow. Only the second one is authorization.
 */
import {
  FLAG_GATE_REQUIREMENTS,
  HARD_FLOORS,
  NON_OVERRIDABLE_GATE_CATEGORIES,
  SAFE_DEFAULT_CONFIG,
  SystemConfigShape,
} from "./constants.ts";

export interface GateRecord {
  gate_key: string;
  category: string;
  status: "not_started" | "in_progress" | "blocked" | "complete";
  approved_date?: string;
  expires_date?: string;
  is_mandatory?: boolean;
}

/** Merge a stored config row over the safe defaults. Missing row => all defaults. */
export function resolveConfig(stored: Partial<SystemConfigShape> | null | undefined): SystemConfigShape {
  return { ...SAFE_DEFAULT_CONFIG, ...(stored ?? {}) } as SystemConfigShape;
}

export function isGateSatisfied(gate: GateRecord, today: string): boolean {
  if (gate.status !== "complete") return false;
  if (gate.expires_date && gate.expires_date < today) return false;
  return true;
}

export interface GateCheckResult {
  satisfied: boolean;
  missing: string[];
  expired: string[];
}

/** Are all gates required for this flag complete and unexpired? */
export function checkGatesForFlag(
  flag: string,
  gates: GateRecord[],
  today: string,
): GateCheckResult {
  const requiredCategories = FLAG_GATE_REQUIREMENTS[flag] ?? [];
  const missing: string[] = [];
  const expired: string[] = [];

  for (const category of requiredCategories) {
    const inCategory = gates.filter((g) => g.category === category);
    if (inCategory.length === 0) {
      missing.push(category);
      continue;
    }
    const allComplete = inCategory.every((g) => g.status === "complete");
    if (!allComplete) {
      missing.push(category);
      continue;
    }
    const anyExpired = inCategory.some((g) => g.expires_date && g.expires_date < today);
    if (anyExpired) expired.push(category);
  }

  return { satisfied: missing.length === 0 && expired.length === 0, missing, expired };
}

export interface FlagChangeRequest {
  flag: string;
  value: unknown;
  /** Typed justification, required for any override attempt. */
  overrideJustification?: string;
  reauthenticated?: boolean;
}

export interface FlagChangeVerdict {
  allowed: boolean;
  code: string;
  message: string;
  usedOverride: boolean;
}

/**
 * Decide whether an admin may make this configuration change. Called by
 * admin-update-config before any write.
 */
export function evaluateFlagChange(
  req: FlagChangeRequest,
  current: SystemConfigShape,
  gates: GateRecord[],
  today: string,
): FlagChangeVerdict {
  const deny = (code: string, message: string): FlagChangeVerdict => ({
    allowed: false, code, message, usedOverride: false,
  });

  // Numeric floors first — these are never overridable.
  if (req.flag === "minimum_driver_age") {
    const v = Number(req.value);
    if (!Number.isInteger(v) || v < HARD_FLOORS.minimum_driver_age) {
      return deny("below_legal_floor", `Minimum driver age cannot be set below ${HARD_FLOORS.minimum_driver_age}.`);
    }
  }
  if (req.flag === "minimum_minor_transport_driver_age") {
    const v = Number(req.value);
    const currentValue = Number(current.minimum_minor_transport_driver_age);
    if (!Number.isInteger(v) || v < HARD_FLOORS.minimum_minor_transport_driver_age) {
      return deny("below_legal_floor", `Minor-transport driver age cannot be set below ${HARD_FLOORS.minimum_minor_transport_driver_age}.`);
    }
    if (v < currentValue) {
      return deny("downward_change_blocked", "This threshold can only be raised.");
    }
  }
  if (req.flag === "driver_tip_annual_cap_cents") {
    const v = Number(req.value);
    if (!Number.isInteger(v) || v < 0) return deny("invalid_value", "A cap must be a non-negative whole number of cents.");
    if (!current.direct_driver_tips_enabled && v !== 0) {
      return deny("tips_disabled", "The tip cap stays at 0 while tipping is disabled.");
    }
  }

  // Turning a flag OFF is always allowed — the safe direction.
  const isEnabling = req.value === true;
  if (!isEnabling) {
    return { allowed: true, code: "ok", message: "Change accepted.", usedOverride: false };
  }

  const requirements = FLAG_GATE_REQUIREMENTS[req.flag];
  if (!requirements) {
    return { allowed: true, code: "ok", message: "Change accepted.", usedOverride: false };
  }

  const gateCheck = checkGatesForFlag(req.flag, gates, today);
  if (gateCheck.satisfied) {
    return { allowed: true, code: "ok", message: "All required launch gates are complete.", usedOverride: false };
  }

  // Enabling is blocked. An override may be attempted, but never for a
  // non-overridable category, and never without typed justification + reauth.
  const blockedCategories = [...gateCheck.missing, ...gateCheck.expired];
  const hasNonOverridable = blockedCategories.some((c) => NON_OVERRIDABLE_GATE_CATEGORIES.includes(c));
  if (hasNonOverridable) {
    return deny(
      "gate_not_overridable",
      `Blocked by mandatory gates that cannot be overridden: ${blockedCategories.join(", ")}.`,
    );
  }
  if (!req.overrideJustification || req.overrideJustification.trim().length < 40) {
    return deny(
      "gate_incomplete",
      `Blocked by incomplete launch gates: ${blockedCategories.join(", ")}. An override needs a written justification of at least 40 characters.`,
    );
  }
  if (!req.reauthenticated) {
    return deny("reauth_required", "Re-authenticate before using an emergency override.");
  }

  return {
    allowed: true,
    code: "override_used",
    message: `Emergency override applied over: ${blockedCategories.join(", ")}. An audit alert has been raised.`,
    usedOverride: true,
  };
}

/**
 * Runtime capability gate used by ride functions. Both the flag and its gates
 * must hold, every request, not just at the moment the flag was flipped.
 */
export function canFulfillRides(config: SystemConfigShape, gates: GateRecord[], today: string): FlagChangeVerdict {
  if (!config.ride_fulfillment_enabled) {
    return {
      allowed: false,
      code: "fulfillment_disabled",
      message: "Ride fulfillment is off. Requests are accepted and reviewed, but no ride is offered or driven.",
      usedOverride: false,
    };
  }
  const gateCheck = checkGatesForFlag("ride_fulfillment_enabled", gates, today);
  if (!gateCheck.satisfied) {
    return {
      allowed: false,
      code: "gate_incomplete",
      message: "Ride fulfillment is blocked by incomplete or expired launch gates.",
      usedOverride: false,
    };
  }
  return { allowed: true, code: "ok", message: "Fulfillment permitted.", usedOverride: false };
}
