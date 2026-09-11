/**
 * Pickup and drop-off handoff for a child. Pure module.
 *
 * The rules that matter here:
 *   - a child is handed to a NAMED, recorded adult, never to whoever is standing there
 *   - the PIN rotates and is never reused for the same child, ever
 *   - the driver never sees the PIN; the adult reads it out
 *   - a failed handoff means STOP, not improvise
 */
import { safeEqual, verificationCode } from "./ids.ts";

export type HandoffRole = "pickup" | "dropoff" | "both";

export interface AuthorizedAdult {
  id: string;
  dependent_profile_id: string;
  name: string;
  relationship: string;
  phone: string;
  role: HandoffRole;
  /** Optional and only where a guardian approved it. */
  photo_reference?: string;
  active: boolean;
}

export interface HandoffPin {
  /** The PIN itself. Stored server-side, shown only to the authorized adult. */
  pin: string;
  issued_at: string;
  used_at?: string;
  /** PINs already issued for this child, so one is never reused. */
}

/**
 * Issue a fresh PIN that has never been used for this child before.
 *
 * `previouslyIssued` is every PIN this child has ever had. Reuse is not "rare"
 * here; it is impossible by construction, because a repeated PIN across trips is
 * exactly what someone watching the pickup point would learn.
 */
export function issueHandoffPin(previouslyIssued: string[], length = 6): string {
  const used = new Set(previouslyIssued);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = verificationCode(length);
    if (!used.has(candidate)) return candidate;
  }
  // Exhausting 50 draws from a 32^6 space means something is wrong upstream.
  throw new Error("could_not_issue_unique_pin");
}

export interface HandoffAttempt {
  dependent_profile_id: string;
  ride_request_id: string;
  role: "pickup" | "dropoff";
  /** The adult the driver says is in front of them. */
  claimed_adult_id: string;
  /** What that adult read out. */
  submitted_pin: string;
  now: string;
}

export interface HandoffState {
  expected_pin: string;
  expected_adult_ids: string[];
  pin_issued_at: string;
  pin_used_at?: string;
  failed_attempts: number;
}

export type HandoffOutcome =
  | { ok: true; code: "handoff_verified"; message: string }
  | { ok: false; code: string; message: string; escalate: boolean };

export const MAX_HANDOFF_ATTEMPTS = 3;
/** A PIN issued long before the trip is stale and gets reissued. */
export const PIN_MAX_AGE_HOURS = 24;

/**
 * Verify one handoff attempt.
 *
 * Every failure path ends in "stop and call", never in a suggestion to try
 * something else. The driver is not asked to make a judgement about whether the
 * person seems fine.
 */
export function verifyHandoff(
  attempt: HandoffAttempt,
  state: HandoffState,
  adults: AuthorizedAdult[],
): HandoffOutcome {
  const stop = (code: string, message: string, escalate = true): HandoffOutcome =>
    ({ ok: false, code, message, escalate });

  if (state.failed_attempts >= MAX_HANDOFF_ATTEMPTS) {
    return stop(
      "too_many_attempts",
      "Too many wrong codes. Stop here, stay with the child, and call the safety line. Do not go anywhere else.",
    );
  }

  const adult = adults.find((a) => a.id === attempt.claimed_adult_id);
  if (!adult) {
    return stop(
      "adult_not_recorded",
      "That person is not on the list for this child. Do not hand the child over. Stay where you are and call the safety line.",
    );
  }
  if (!adult.active) {
    return stop(
      "adult_no_longer_authorized",
      "That person has been taken off the list for this child. Do not hand the child over. Call the safety line.",
    );
  }
  if (adult.dependent_profile_id !== attempt.dependent_profile_id) {
    return stop(
      "adult_other_child",
      "That person is listed for a different child. Do not hand the child over. Call the safety line.",
    );
  }
  if (adult.role !== "both" && adult.role !== attempt.role) {
    return stop(
      "adult_wrong_role",
      `That person is listed for ${adult.role}, not ${attempt.role}. Do not hand the child over. Call the safety line.`,
    );
  }

  if (state.pin_used_at) {
    return stop(
      "pin_already_used",
      "That code has already been used. Stop and call the safety line.",
    );
  }
  const ageHours = (new Date(attempt.now).getTime() - new Date(state.pin_issued_at).getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > PIN_MAX_AGE_HOURS) {
    return stop(
      "pin_stale",
      "That code is out of date. Stop and call the safety line for a fresh one.",
    );
  }

  const submitted = (attempt.submitted_pin ?? "").trim().toUpperCase();
  if (!state.expected_pin || !safeEqual(state.expected_pin, submitted)) {
    const left = MAX_HANDOFF_ATTEMPTS - state.failed_attempts - 1;
    return stop(
      "pin_mismatch",
      left > 0
        ? `That code does not match. ${left} ${left === 1 ? "try" : "tries"} left. Do not hand the child over while it is wrong.`
        : "That code does not match. Stop here, stay with the child, and call the safety line.",
      left <= 0,
    );
  }

  if (!state.expected_adult_ids.includes(adult.id)) {
    return stop(
      "adult_not_expected_for_this_trip",
      "That person is not the one expected for this trip. Do not hand the child over. Call the safety line.",
    );
  }

  return {
    ok: true,
    code: "handoff_verified",
    message: `Verified. ${adult.name} (${adult.relationship}) may take the child.`,
  };
}

/**
 * What a driver is told when a handoff cannot be completed.
 *
 * Note what is absent: any alternative destination, any suggestion to wait
 * somewhere else, any instruction that involves leaving the child.
 */
export const FAILED_HANDOFF_INSTRUCTIONS = [
  "Stop where you are. Do not drive anywhere else.",
  "Stay with the child. Never leave a child unattended, and never leave them with someone who is not on the list.",
  "Call the safety line now.",
  "If the child is in danger or hurt, call 911 first.",
  "Wait for a coordinator to tell you what happens next. Do not decide a new drop-off yourself.",
];

/** A minor's handoff details are only ever released to the assigned driver, close to the trip. */
export function mayRevealHandoffDetails(
  isAssignedDriver: boolean,
  rideStatus: string,
  minutesUntilPickup: number,
): boolean {
  if (!isAssignedDriver) return false;
  const activeStates = ["confirmed", "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff"];
  if (!activeStates.includes(rideStatus)) return false;
  return minutesUntilPickup <= 120;
}
