/**
 * Presentation helpers shared by the rider, driver, and dispatcher views.
 * Pure, so the tests cover the labels people actually read.
 */

/** The rider-facing journey, as a transit line. Exception states sit outside it. */
export const ROUTE_STEPS = [
  { state: "submitted", label: "Requested" },
  { state: "eligibility_review", label: "Being reviewed" },
  { state: "approved", label: "Approved" },
  { state: "offered", label: "Finding a driver" },
  { state: "confirmed", label: "Driver confirmed" },
  { state: "en_route", label: "On the way to you" },
  { state: "in_progress", label: "Riding" },
  { state: "completed", label: "Arrived" },
] as const;

const ALIASES: Record<string, string> = {
  draft: "submitted",
  awaiting_consent: "eligibility_review",
  waitlisted: "approved",
  claimed: "confirmed",
  arrived_pickup: "en_route",
  rider_verified: "in_progress",
  arrived_dropoff: "in_progress",
  handoff_verified: "completed",
};

export function routePosition(status: string): number {
  const normalized = ALIASES[status] ?? status;
  const index = ROUTE_STEPS.findIndex((s) => s.state === normalized);
  return index;
}

export const EXCEPTION_STATES: Record<string, string> = {
  canceled: "Canceled",
  driver_canceled: "Driver released this ride",
  rider_no_show: "Rider not found at pickup",
  failed_handoff: "Drop-off could not be completed",
  incident_hold: "On hold with the safety team",
  closed_by_admin: "Closed by a coordinator",
  waitlisted: "On the waitlist",
};

export function statusLabel(status: string): string {
  if (EXCEPTION_STATES[status]) return EXCEPTION_STATES[status];
  const index = routePosition(status);
  return index >= 0 ? ROUTE_STEPS[index].label : status.replace(/_/g, " ");
}

export function statusTone(status: string): "wait" | "go" | "stop" | "live" {
  if (["completed", "handoff_verified"].includes(status)) return "go";
  if (["canceled", "driver_canceled", "rider_no_show", "failed_handoff", "incident_hold", "closed_by_admin"].includes(status)) return "stop";
  if (["en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff"].includes(status)) return "live";
  return "wait";
}

export const RESOURCE_CATEGORY_LABELS: Record<string, string> = {
  food_pantry: "Food pantry",
  free_fridge: "Free fridge",
  mutual_aid_supplies: "Mutual aid supplies",
  clothing: "Clothing",
  social_services: "Social services",
  education_program: "Education program",
  workforce: "Job or training",
  non_emergency_appointment: "Non-emergency appointment",
  community_event: "Community event",
  other: "Something else",
};

/** Format a time window the way someone reads it on a schedule. */
export function windowLabel(startIso?: string, minutes = 30): string {
  if (!startIso) return "Time to be confirmed";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "Time to be confirmed";
  const end = new Date(start.getTime() + minutes * 60_000);
  const day = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${t(start)}–${t(end)}`;
}
