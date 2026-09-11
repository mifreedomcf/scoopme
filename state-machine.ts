/**
 * Server-validated ride state machine. Pure module.
 *
 * Every transition is checked here before any write. The UI never decides
 * whether a transition is legal; it only asks.
 */
import { RideState, TERMINAL_STATES } from "./constants.ts";

export type ActorRole =
  | "rider"
  | "guardian"
  | "org_scheduler"
  | "driver"
  | "dispatcher"
  | "safety_staff"
  | "platform_admin"
  | "system";

export interface TransitionRule {
  from: RideState;
  to: RideState;
  /** Who may request this transition. */
  actors: ActorRole[];
  /** Human-readable reason the rule exists; surfaced in denials and docs. */
  note: string;
  /** A reason code must accompany this transition. */
  requiresReason?: boolean;
}

export const TRANSITIONS: TransitionRule[] = [
  { from: "draft", to: "submitted", actors: ["rider", "guardian", "org_scheduler", "dispatcher"], note: "Requester submits the request." },
  { from: "submitted", to: "eligibility_review", actors: ["system", "dispatcher"], note: "Server queues deterministic eligibility checks." },
  { from: "eligibility_review", to: "awaiting_consent", actors: ["system", "dispatcher"], note: "Minor ride, or an organization-created request needing the rider's own authorization." },
  { from: "eligibility_review", to: "approved", actors: ["dispatcher", "platform_admin"], note: "Staff approves after review. Never automatic." },
  { from: "eligibility_review", to: "waitlisted", actors: ["dispatcher", "platform_admin"], note: "No capacity in the window.", requiresReason: true },
  { from: "eligibility_review", to: "canceled", actors: ["rider", "guardian", "org_scheduler", "dispatcher", "platform_admin"], note: "Withdrawn or rejected.", requiresReason: true },
  { from: "awaiting_consent", to: "approved", actors: ["dispatcher", "platform_admin"], note: "Verified consent recorded, then staff approves." },
  { from: "awaiting_consent", to: "canceled", actors: ["guardian", "rider", "dispatcher", "platform_admin"], note: "Consent refused or expired.", requiresReason: true },
  { from: "waitlisted", to: "approved", actors: ["dispatcher", "platform_admin"], note: "Capacity opened." },
  { from: "waitlisted", to: "canceled", actors: ["rider", "guardian", "org_scheduler", "dispatcher", "platform_admin"], note: "No longer needed.", requiresReason: true },
  { from: "approved", to: "offered", actors: ["dispatcher", "system", "platform_admin"], note: "Minimized offers published to eligible drivers." },
  { from: "approved", to: "canceled", actors: ["rider", "guardian", "org_scheduler", "dispatcher", "platform_admin"], note: "Canceled before offer.", requiresReason: true },
  { from: "offered", to: "claimed", actors: ["driver", "dispatcher", "platform_admin"], note: "A single eligible driver claims, under a lock." },
  { from: "offered", to: "waitlisted", actors: ["dispatcher", "system", "platform_admin"], note: "Offers expired unclaimed.", requiresReason: true },
  { from: "offered", to: "canceled", actors: ["rider", "guardian", "org_scheduler", "dispatcher", "platform_admin"], note: "Canceled while open.", requiresReason: true },
  { from: "claimed", to: "confirmed", actors: ["dispatcher", "system", "platform_admin"], note: "Assignment confirmed and the verification code is issued." },
  { from: "claimed", to: "driver_canceled", actors: ["driver", "dispatcher", "platform_admin"], note: "Driver releases the ride.", requiresReason: true },
  { from: "confirmed", to: "en_route", actors: ["driver"], note: "Driver starts toward pickup." },
  { from: "confirmed", to: "driver_canceled", actors: ["driver", "dispatcher", "platform_admin"], note: "Driver releases before departure.", requiresReason: true },
  { from: "confirmed", to: "canceled", actors: ["rider", "guardian", "org_scheduler", "dispatcher", "platform_admin"], note: "Rider cancels.", requiresReason: true },
  { from: "en_route", to: "arrived_pickup", actors: ["driver"], note: "Driver reports arrival." },
  { from: "en_route", to: "driver_canceled", actors: ["driver", "dispatcher", "platform_admin"], note: "Breakdown or emergency.", requiresReason: true },
  { from: "arrived_pickup", to: "rider_verified", actors: ["driver", "dispatcher"], note: "Rider verifies driver and vehicle; driver verifies the rider." },
  { from: "arrived_pickup", to: "rider_no_show", actors: ["driver", "dispatcher", "platform_admin"], note: "Rider not present after the wait policy.", requiresReason: true },
  { from: "rider_verified", to: "in_progress", actors: ["driver"], note: "Trip underway." },
  { from: "in_progress", to: "arrived_dropoff", actors: ["driver"], note: "Arrived at the resource." },
  { from: "arrived_dropoff", to: "handoff_verified", actors: ["driver", "dispatcher"], note: "Drop-off confirmed; for a minor, a verified authorized adult with a valid PIN." },
  { from: "arrived_dropoff", to: "failed_handoff", actors: ["driver", "dispatcher", "safety_staff"], note: "No authorized adult or PIN mismatch. Triggers the safety protocol; the driver must not improvise a destination.", requiresReason: true },
  { from: "handoff_verified", to: "completed", actors: ["driver", "dispatcher", "system"], note: "Ride complete." },
  { from: "failed_handoff", to: "incident_hold", actors: ["safety_staff", "dispatcher", "platform_admin"], note: "Escalated to safety staff.", requiresReason: true },
  { from: "rider_no_show", to: "closed_by_admin", actors: ["dispatcher", "platform_admin"], note: "Administrative closure.", requiresReason: true },
  { from: "driver_canceled", to: "approved", actors: ["dispatcher", "platform_admin"], note: "Returned to the pool for re-offer." },
  { from: "driver_canceled", to: "waitlisted", actors: ["dispatcher", "platform_admin"], note: "No replacement available.", requiresReason: true },
  { from: "incident_hold", to: "closed_by_admin", actors: ["platform_admin"], note: "Closed after safety review.", requiresReason: true },
];

/** Any live ride may be pulled into an incident hold by safety staff. */
const INCIDENT_HOLD_SOURCES: RideState[] = [
  "confirmed", "en_route", "arrived_pickup", "rider_verified",
  "in_progress", "arrived_dropoff", "handoff_verified", "completed",
];
for (const from of INCIDENT_HOLD_SOURCES) {
  TRANSITIONS.push({
    from,
    to: "incident_hold",
    actors: ["safety_staff", "platform_admin"],
    note: "Safety staff freeze the ride record pending review.",
    requiresReason: true,
  });
}

export interface TransitionContext {
  actorRole: ActorRole;
  reasonCode?: string;
  /** True when this actor is the assigned driver for this specific ride. */
  isAssignedDriver?: boolean;
  /** True when the actor is the rider, guardian, or authorized scheduler for this ride. */
  isRideParty?: boolean;
  /** A DataRetentionHold is active on the ride. */
  retentionHoldActive?: boolean;
}

export interface TransitionResult {
  allowed: boolean;
  code: string;
  message: string;
}

export function findRule(from: RideState, to: RideState): TransitionRule | undefined {
  return TRANSITIONS.find((r) => r.from === from && r.to === to);
}

export function allowedTransitionsFrom(from: RideState): RideState[] {
  return TRANSITIONS.filter((r) => r.from === from).map((r) => r.to);
}

/**
 * The single authority on whether a ride may move. Backend functions call this
 * before every write; nothing else may change RideRequest.status.
 */
export function canTransition(
  from: RideState,
  to: RideState,
  ctx: TransitionContext,
): TransitionResult {
  if (from === to) {
    return { allowed: false, code: "no_op", message: "The ride is already in that state." };
  }
  if (TERMINAL_STATES.includes(from) && to !== "incident_hold") {
    return { allowed: false, code: "terminal_state", message: `A ${from} ride cannot move again.` };
  }

  const rule = findRule(from, to);
  if (!rule) {
    return { allowed: false, code: "illegal_transition", message: `${from} cannot become ${to}.` };
  }
  if (!rule.actors.includes(ctx.actorRole)) {
    return { allowed: false, code: "actor_not_permitted", message: `A ${ctx.actorRole} cannot make this change.` };
  }
  if (rule.requiresReason && !ctx.reasonCode) {
    return { allowed: false, code: "reason_required", message: "This change needs a reason code." };
  }

  // A driver may only move the ride they are actually assigned to.
  if (ctx.actorRole === "driver" && !ctx.isAssignedDriver && to !== "claimed") {
    return { allowed: false, code: "not_assigned_driver", message: "You are not the assigned driver for this ride." };
  }
  // A rider or scheduler may only move their own ride.
  if ((ctx.actorRole === "rider" || ctx.actorRole === "guardian" || ctx.actorRole === "org_scheduler") && !ctx.isRideParty) {
    return { allowed: false, code: "not_ride_party", message: "This is not your ride." };
  }
  // A retention hold blocks ordinary closure, but never blocks safety escalation.
  if (ctx.retentionHoldActive && to === "closed_by_admin") {
    return { allowed: false, code: "retention_hold_active", message: "A legal or incident hold is active on this record." };
  }

  return { allowed: true, code: "ok", message: rule.note };
}
