/**
 * Reporting aggregation and small-cell suppression. Pure module.
 *
 * Two rules shape everything here. Reports about people who use a free service
 * must not become a way to identify them, so any cell built from fewer than a
 * threshold number of people is suppressed rather than rounded. And a partner
 * report shows only that partner's own participants and destination activity —
 * scoping is applied before aggregation, never as a filter on the way out.
 */

/** Below this many distinct people, a cell is suppressed. */
export const SMALL_CELL_THRESHOLD = 5;

export type Audience = "public" | "partner" | "organization" | "staff";

export interface RideFact {
  ride_id: string;
  rider_user_id: string;
  organization_id?: string;
  destination_location_id?: string;
  partner_id?: string;
  resource_category?: string;
  pickup_zip?: string;
  status: string;
  requested_pickup_at?: string;
  arrival_by_at?: string;
  completed_at?: string;
  passenger_count?: number;
  rider_kind?: string;
  accommodations_requested: string[];
  accommodations_fulfilled: string[];
  /** Straight-line miles, computed server-side. Never a tracked route. */
  miles?: number;
  volunteer_minutes?: number;
}

export interface ReportScope {
  audience: Audience;
  /** Restricts to one organization's own participants. */
  organizationId?: string;
  /** Restricts to one partner's destinations. */
  partnerId?: string;
  from?: string;
  to?: string;
}

export type Cell = number | "suppressed";

export interface ReportResult {
  scope: ReportScope;
  totals: {
    requests: Cell;
    completed: Cell;
    waitlisted: Cell;
    unfilled: Cell;
    canceled: Cell;
    no_shows: Cell;
    unique_riders: Cell;
    passengers: Cell;
    miles: Cell;
    volunteer_hours: Cell;
    on_time_rate: number | "suppressed" | null;
  };
  by_resource_category: Record<string, Cell>;
  by_pickup_zip: Record<string, Cell>;
  accommodations: { requested: Record<string, Cell>; fulfilled: Record<string, Cell> };
  /** Cells that were withheld, so a reader knows the difference between zero and hidden. */
  suppressed_cells: string[];
  notes: string[];
}

/** Apply the scope BEFORE anything is counted. */
export function scopeFacts(facts: RideFact[], scope: ReportScope): RideFact[] {
  return facts.filter((f) => {
    if (scope.organizationId && f.organization_id !== scope.organizationId) return false;
    if (scope.partnerId && f.partner_id !== scope.partnerId) return false;
    if (scope.from && (f.requested_pickup_at ?? "") < scope.from) return false;
    if (scope.to && (f.requested_pickup_at ?? "") > scope.to) return false;
    // Minors never appear in an ordinary report, at any audience.
    if (f.rider_kind === "minor" && scope.audience !== "staff") return false;
    return true;
  });
}

function distinctRiders(facts: RideFact[]): number {
  return new Set(facts.map((f) => f.rider_user_id)).size;
}

/**
 * Suppress a cell when the people behind it are too few to stay anonymous.
 * Staff see real numbers; every other audience does not.
 */
function cell(value: number, riderCount: number, audience: Audience): Cell {
  if (audience === "staff") return value;
  if (value === 0) return 0;
  if (riderCount < SMALL_CELL_THRESHOLD) return "suppressed";
  return value;
}

const COMPLETED = ["completed"];
const WAITLISTED = ["waitlisted"];
const CANCELED = ["canceled", "driver_canceled", "closed_by_admin"];
const NO_SHOW = ["rider_no_show"];

export function buildReport(allFacts: RideFact[], scope: ReportScope): ReportResult {
  const facts = scopeFacts(allFacts, scope);
  const riders = distinctRiders(facts);
  const suppressed: string[] = [];
  const notes: string[] = [];

  const track = (name: string, value: Cell): Cell => {
    if (value === "suppressed") suppressed.push(name);
    return value;
  };

  const completed = facts.filter((f) => COMPLETED.includes(f.status));
  const waitlisted = facts.filter((f) => WAITLISTED.includes(f.status));
  const canceled = facts.filter((f) => CANCELED.includes(f.status));
  const noShows = facts.filter((f) => NO_SHOW.includes(f.status));
  // "Unfilled" means the window passed with nobody driving it.
  const unfilled = facts.filter(
    (f) => WAITLISTED.includes(f.status) || (f.status === "approved" && (f.requested_pickup_at ?? "") < (scope.to ?? "")),
  );

  const onTime = completed.filter(
    (f) => !f.arrival_by_at || !f.completed_at || f.completed_at <= f.arrival_by_at,
  ).length;
  const onTimeRate = completed.length === 0
    ? null
    : (scope.audience !== "staff" && riders < SMALL_CELL_THRESHOLD
        ? "suppressed"
        : Math.round((onTime / completed.length) * 100) / 100);
  if (onTimeRate === "suppressed") suppressed.push("on_time_rate");

  const groupBy = (key: (f: RideFact) => string | undefined, label: string): Record<string, Cell> => {
    const groups = new Map<string, RideFact[]>();
    for (const f of facts) {
      const k = key(f);
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    const out: Record<string, Cell> = {};
    for (const [k, group] of groups) {
      out[k] = track(`${label}:${k}`, cell(group.length, distinctRiders(group), scope.audience));
    }
    return out;
  };

  const accommodationGroup = (pick: (f: RideFact) => string[], label: string): Record<string, Cell> => {
    const groups = new Map<string, RideFact[]>();
    for (const f of facts) {
      for (const a of pick(f)) groups.set(a, [...(groups.get(a) ?? []), f]);
    }
    const out: Record<string, Cell> = {};
    for (const [k, group] of groups) {
      out[k] = track(`${label}:${k}`, cell(group.length, distinctRiders(group), scope.audience));
    }
    return out;
  };

  if (scope.audience !== "staff") {
    notes.push(
      `Counts drawn from fewer than ${SMALL_CELL_THRESHOLD} people are shown as suppressed, not as a number.`,
    );
    notes.push("Rides for under-18 riders, exact addresses, trip purposes, and incident details are never included.");
  }

  return {
    scope,
    totals: {
      requests: track("requests", cell(facts.length, riders, scope.audience)),
      completed: track("completed", cell(completed.length, distinctRiders(completed), scope.audience)),
      waitlisted: track("waitlisted", cell(waitlisted.length, distinctRiders(waitlisted), scope.audience)),
      unfilled: track("unfilled", cell(unfilled.length, distinctRiders(unfilled), scope.audience)),
      canceled: track("canceled", cell(canceled.length, distinctRiders(canceled), scope.audience)),
      no_shows: track("no_shows", cell(noShows.length, distinctRiders(noShows), scope.audience)),
      unique_riders: track("unique_riders", cell(riders, riders, scope.audience)),
      passengers: track(
        "passengers",
        cell(facts.reduce((n, f) => n + (f.passenger_count ?? 1), 0), riders, scope.audience),
      ),
      miles: track(
        "miles",
        cell(Math.round(completed.reduce((n, f) => n + (f.miles ?? 0), 0)), distinctRiders(completed), scope.audience),
      ),
      volunteer_hours: track(
        "volunteer_hours",
        cell(
          Math.round(completed.reduce((n, f) => n + (f.volunteer_minutes ?? 0), 0) / 60),
          distinctRiders(completed),
          scope.audience,
        ),
      ),
      on_time_rate: onTimeRate,
    },
    by_resource_category: groupBy((f) => f.resource_category, "resource_category"),
    by_pickup_zip: groupBy((f) => f.pickup_zip, "pickup_zip"),
    accommodations: {
      requested: accommodationGroup((f) => f.accommodations_requested, "accommodation_requested"),
      fulfilled: accommodationGroup((f) => f.accommodations_fulfilled, "accommodation_fulfilled"),
    },
    suppressed_cells: suppressed,
    notes,
  };
}

/** Render a report as CSV. A suppressed cell is written as the word, never as 0. */
export function toCsv(report: ReportResult): string {
  const rows: string[][] = [["metric", "value"]];
  for (const [k, v] of Object.entries(report.totals)) {
    rows.push([k, v === null ? "" : String(v)]);
  }
  for (const [k, v] of Object.entries(report.by_resource_category)) rows.push([`resource_category.${k}`, String(v)]);
  for (const [k, v] of Object.entries(report.by_pickup_zip)) rows.push([`pickup_zip.${k}`, String(v)]);
  for (const [k, v] of Object.entries(report.accommodations.requested)) rows.push([`accommodation_requested.${k}`, String(v)]);
  for (const [k, v] of Object.entries(report.accommodations.fulfilled)) rows.push([`accommodation_fulfilled.${k}`, String(v)]);
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}
