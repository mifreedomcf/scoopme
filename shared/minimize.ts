/**
 * Data minimization. Pure module.
 *
 * One place decides what a given viewer is allowed to see about a ride. Every
 * function that returns ride data to a client passes through here.
 */
import { NEVER_MINIMIZED_SAFE_FIELDS } from "./constants.ts";

export type ViewerKind =
  | "public"
  | "rider"
  | "guardian"
  | "org_scheduler"
  | "unassigned_driver"
  | "assigned_driver"
  | "dispatcher"
  | "safety_staff"
  | "platform_admin";

export interface RideRecord {
  id: string;
  status: string;
  rider_kind: string;
  pickup_address?: string;
  pickup_area_label?: string;
  pickup_zip?: string;
  pickup_latitude?: number;
  pickup_longitude?: number;
  destination_address?: string;
  destination_area_label?: string;
  destination_zip?: string;
  destination_latitude?: number;
  destination_longitude?: number;
  resource_category?: string;
  requested_pickup_at?: string;
  arrival_by_at?: string;
  flexible_window_minutes?: number;
  passenger_count?: number;
  language_preference?: string;
  assistance_level?: string;
  service_animal?: boolean;
  contact_phone?: string;
  operational_notes?: string;
  verification_code?: string;
  [key: string]: unknown;
}

export interface RevealContext {
  viewer: ViewerKind;
  /** True once the assignment's reveal window has opened. */
  revealWindowOpen?: boolean;
  /** Ride is finished; exact location must stop being shown. */
  rideCompleted?: boolean;
}

const OFFER_FIELDS = [
  "id",
  "status",
  "pickup_area_label",
  "destination_area_label",
  "resource_category",
  "requested_pickup_at",
  "arrival_by_at",
  "flexible_window_minutes",
  "passenger_count",
];

const PARTY_FIELDS = [
  ...OFFER_FIELDS,
  "pickup_address",
  "destination_address",
  "pickup_zip",
  "destination_zip",
  "contact_phone",
  "verification_code",
  "language_preference",
  "assistance_level",
  "service_animal",
  "operational_notes",
];

function pick(record: RideRecord, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (record[f] !== undefined) out[f] = record[f];
  }
  return out;
}

/**
 * Build the payload a viewer may receive. An unassigned driver gets an
 * approximate area, a category, a window, a passenger count, and nothing else —
 * no address, no coordinates, no contact details, no verification code.
 */
export function minimizeRide(record: RideRecord, ctx: RevealContext): Record<string, unknown> {
  switch (ctx.viewer) {
    case "public":
      return { id: record.id, status: record.status };

    case "unassigned_driver":
      return pick(record, OFFER_FIELDS);

    case "assigned_driver": {
      if (!ctx.revealWindowOpen) return pick(record, OFFER_FIELDS);
      const payload = pick(record, [
        ...OFFER_FIELDS,
        "pickup_address",
        "destination_address",
        "contact_phone",
        "assistance_level",
        "service_animal",
        "language_preference",
        "operational_notes",
      ]);
      // Exact coordinates stop being shared once the ride is finished.
      if (!ctx.rideCompleted) {
        payload.pickup_latitude = record.pickup_latitude;
        payload.pickup_longitude = record.pickup_longitude;
        payload.destination_latitude = record.destination_latitude;
        payload.destination_longitude = record.destination_longitude;
      }
      return payload;
    }

    case "rider":
    case "guardian":
      return pick(record, PARTY_FIELDS);

    case "org_scheduler":
      // A scheduler sees enough to coordinate, never the rider's verification code.
      return pick(record, PARTY_FIELDS.filter((f) => f !== "verification_code"));

    case "dispatcher":
    case "safety_staff":
    case "platform_admin":
      return { ...record };

    default:
      return { id: record.id, status: record.status };
  }
}

/**
 * Guard for notification bodies. Notifications go to lock screens; a sensitive
 * destination or exact address must never appear in one.
 */
export function assertNotificationSafe(body: string, record: RideRecord): { safe: boolean; leaked: string[] } {
  const leaked: string[] = [];
  for (const field of NEVER_MINIMIZED_SAFE_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length >= 5 && body.includes(value)) {
      leaked.push(field);
    }
  }
  return { safe: leaked.length === 0, leaked };
}

/** Strip known-sensitive keys before anything is written to an audit or app log. */
export function redactForLog(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (NEVER_MINIMIZED_SAFE_FIELDS.includes(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (/token|secret|password|api[_-]?key|ssn|card/i.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = typeof v === "object" && v !== null ? "[object]" : v;
  }
  return out;
}
