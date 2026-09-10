/**
 * Ride check-in timers and escalation. Pure module.
 *
 * These rules raise a flag for a person. They never cancel a ride, never
 * contact emergency services, and never decide that something is or is not an
 * emergency. A human reads the alert and acts.
 */

export type EscalationKind =
  | "overdue_departure"
  | "overdue_arrival_pickup"
  | "stalled_at_pickup"
  | "overdue_arrival_dropoff"
  | "loss_of_contact"
  | "handoff_overdue";

export type EscalationLevel = 0 | 1 | 2;

export interface RideWatchInput {
  status: string;
  requested_pickup_at?: string;
  arrival_by_at?: string;
  /** Last time the assigned driver or the rider touched the ride. */
  last_check_in_at?: string;
  /** Level already raised, so the same alert is not raised twice. */
  escalation_level?: EscalationLevel;
  now: Date;
}

export interface EscalationVerdict {
  raise: boolean;
  kind?: EscalationKind;
  level: EscalationLevel;
  /** Copy for the dispatcher board. Never contains an address or a code. */
  message?: string;
  minutesLate?: number;
}

/** Thresholds in minutes. Deliberately generous: a nuisance alert gets ignored. */
export const THRESHOLDS = {
  departure_grace: 15,
  pickup_arrival_grace: 20,
  stalled_at_pickup: 20,
  dropoff_arrival_grace: 30,
  contact_silence: 45,
  handoff_grace: 15,
  /** After this much lateness the alert escalates from notice to urgent. */
  urgent_multiplier: 2,
};

function minutesBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 60_000);
}

function levelFor(minutesLate: number, threshold: number, already: EscalationLevel): EscalationVerdict["level"] {
  const urgent = minutesLate >= threshold * THRESHOLDS.urgent_multiplier;
  const level: EscalationLevel = urgent ? 2 : 1;
  return level > already ? level : already;
}

/**
 * Decide whether this ride needs a human to look at it right now.
 * Returns `raise: false` when nothing has changed since the last alert.
 */
export function evaluateRideWatch(input: RideWatchInput): EscalationVerdict {
  const already = (input.escalation_level ?? 0) as EscalationLevel;
  const none: EscalationVerdict = { raise: false, level: already };

  const pickup = input.requested_pickup_at ? new Date(input.requested_pickup_at) : null;
  const arriveBy = input.arrival_by_at ? new Date(input.arrival_by_at) : null;
  const lastContact = input.last_check_in_at ? new Date(input.last_check_in_at) : null;

  const check = (minutesLate: number, threshold: number, kind: EscalationKind, message: string): EscalationVerdict => {
    if (minutesLate < threshold) return none;
    const level = levelFor(minutesLate, threshold, already);
    if (level <= already) return none;
    return { raise: true, kind, level, message, minutesLate };
  };

  switch (input.status) {
    case "confirmed": {
      if (!pickup) return none;
      return check(
        minutesBetween(input.now, pickup),
        THRESHOLDS.departure_grace,
        "overdue_departure",
        "Driver has not started toward pickup.",
      );
    }
    case "en_route": {
      if (!pickup) return none;
      return check(
        minutesBetween(input.now, pickup),
        THRESHOLDS.pickup_arrival_grace,
        "overdue_arrival_pickup",
        "Driver has not reported arriving at the pickup point.",
      );
    }
    case "arrived_pickup": {
      if (!pickup) return none;
      return check(
        minutesBetween(input.now, pickup),
        THRESHOLDS.stalled_at_pickup,
        "stalled_at_pickup",
        "Driver arrived but the rider has not been verified.",
      );
    }
    case "in_progress":
    case "rider_verified": {
      if (arriveBy) {
        const late = minutesBetween(input.now, arriveBy);
        const verdict = check(late, THRESHOLDS.dropoff_arrival_grace, "overdue_arrival_dropoff", "Ride is running past its arrival time.");
        if (verdict.raise) return verdict;
      }
      if (lastContact) {
        return check(
          minutesBetween(input.now, lastContact),
          THRESHOLDS.contact_silence,
          "loss_of_contact",
          "No update from this ride for a while.",
        );
      }
      return none;
    }
    case "arrived_dropoff": {
      if (!lastContact) return none;
      return check(
        minutesBetween(input.now, lastContact),
        THRESHOLDS.handoff_grace,
        "handoff_overdue",
        "Drop-off has not been confirmed.",
      );
    }
    default:
      return none;
  }
}

/** Who an alert goes to. Level 2 always reaches safety staff, not just dispatch. */
export function escalationAudience(level: EscalationLevel): ("dispatcher" | "safety_staff")[] {
  return level >= 2 ? ["dispatcher", "safety_staff"] : ["dispatcher"];
}
