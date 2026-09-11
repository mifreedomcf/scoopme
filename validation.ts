/**
 * Ride-request input validation. Pure module.
 *
 * The client wizard shows friendly errors; this is what actually decides.
 */
import { SystemConfigShape } from "./constants.ts";

export interface RideRequestInput {
  rider_kind?: string;
  requested_by_kind?: string;
  organization_id?: string;
  participant_authorization_id?: string;
  dependent_profile_id?: string;
  pickup_address?: string;
  destination_location_id?: string;
  destination_address?: string;
  requested_pickup_at?: string;
  arrival_by_at?: string;
  flexible_window_minutes?: number;
  passenger_count?: number;
  resource_category?: string;
  language_preference?: string;
  assistance_level?: string;
  service_animal?: boolean;
  contact_phone?: string;
  operational_notes?: string;
  needs?: { need: string; detail?: string; quantity?: number }[];
  /** Anything a client sends that we do not explicitly accept is dropped. */
  [key: string]: unknown;
}

/** Allowlist. Mass assignment is prevented by construction, not by hope. */
export const ACCEPTED_REQUEST_FIELDS = [
  "rider_kind",
  "requested_by_kind",
  "organization_id",
  "participant_authorization_id",
  "dependent_profile_id",
  "pickup_address",
  "destination_location_id",
  "destination_address",
  "requested_pickup_at",
  "arrival_by_at",
  "flexible_window_minutes",
  "passenger_count",
  "resource_category",
  "language_preference",
  "assistance_level",
  "service_animal",
  "contact_phone",
  "operational_notes",
  "needs",
];

export function stripToAccepted(input: Record<string, unknown>): RideRequestInput {
  const out: Record<string, unknown> = {};
  for (const key of ACCEPTED_REQUEST_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out as RideRequestInput;
}

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Deterministic reasons this request needs a dispatcher to look at it. */
  flags: string[];
}

const PHONE_RE = /^[0-9+()\-.\s]{7,20}$/;

export function validateRideRequest(
  input: RideRequestInput,
  config: SystemConfigShape,
  now: Date,
): ValidationResult {
  const errors: ValidationError[] = [];
  const flags: string[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });

  // Minors: the whole workflow exists but is unreachable while the flag is off.
  const riderKind = input.rider_kind ?? "adult";
  if (riderKind === "minor" || input.dependent_profile_id) {
    if (!config.minor_rides_enabled) {
      err("rider_kind", "minor_rides_disabled", "Rides for minors are not available in this pilot.");
    }
  }
  if (riderKind === "adult" && !config.adult_rides_enabled) {
    err("rider_kind", "adult_rides_disabled", "Ride requests are paused right now.");
  }

  // An organization request needs a recorded participant authorization. Being
  // the person who filled in the form is not authorization, and it is never
  // guardian consent.
  if (input.requested_by_kind === "org_scheduler") {
    if (!input.organization_id) {
      err("organization_id", "organization_required", "Choose the organization making this request.");
    }
    if (!input.participant_authorization_id) {
      err(
        "participant_authorization_id",
        "participant_authorization_required",
        "This participant has not authorized your organization to request rides for them.",
      );
    }
    if (riderKind === "minor") {
      err(
        "requested_by_kind",
        "scheduler_cannot_consent",
        "An organization scheduler cannot give guardian consent. A verified parent or legal guardian must consent separately.",
      );
    }
  }

  // Timing.
  if (!input.requested_pickup_at) {
    err("requested_pickup_at", "required", "Choose a pickup date and time.");
  } else {
    const pickup = new Date(input.requested_pickup_at);
    if (Number.isNaN(pickup.getTime())) {
      err("requested_pickup_at", "invalid_date", "That pickup time is not a valid date.");
    } else {
      const leadHours = (pickup.getTime() - now.getTime()) / 3_600_000;
      if (leadHours < 0) {
        err("requested_pickup_at", "in_the_past", "Pickup time is in the past.");
      } else if (leadHours < config.minimum_request_lead_hours) {
        if (config.same_day_rides_enabled) {
          flags.push("short_notice_request");
        } else {
          err(
            "requested_pickup_at",
            "insufficient_lead_time",
            `Rides need at least ${config.minimum_request_lead_hours} hours' notice.`,
          );
        }
      }
      if (input.arrival_by_at) {
        const arrive = new Date(input.arrival_by_at);
        if (!Number.isNaN(arrive.getTime()) && arrive.getTime() < pickup.getTime()) {
          err("arrival_by_at", "arrival_before_pickup", "Arrival time cannot be before pickup time.");
        }
      }
    }
  }

  // Places.
  if (!input.pickup_address || input.pickup_address.trim().length < 6) {
    err("pickup_address", "required", "Enter a pickup address.");
  }
  if (!input.destination_location_id && !input.destination_address) {
    err("destination_location_id", "required", "Choose where you are going.");
  }

  // Passengers and needs.
  const passengers = input.passenger_count ?? 1;
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 8) {
    err("passenger_count", "out_of_range", "Enter between 1 and 8 passengers.");
  }
  if (input.contact_phone && !PHONE_RE.test(input.contact_phone)) {
    err("contact_phone", "invalid_phone", "Enter a phone number we can reach you on.");
  }
  if (input.assistance_level === "hand_to_hand" && riderKind === "adult") {
    flags.push("hand_to_hand_requested_for_adult");
  }
  for (const need of input.needs ?? []) {
    if (["booster_seat", "forward_facing_car_seat", "rear_facing_car_seat"].includes(need.need) && riderKind === "adult") {
      flags.push("child_restraint_requested_on_adult_ride");
    }
  }

  // Fields we refuse to collect at all.
  for (const banned of ["diagnosis", "medical_details", "ssn", "social_security_number", "immigration_status"]) {
    if (input[banned] !== undefined) {
      err(banned, "field_not_collected", "This platform does not collect that information.");
    }
  }

  if (config.geocoder_provider_mode !== "live") flags.push("geocoder_in_mock_mode");
  if (!config.ride_fulfillment_enabled) flags.push("fulfillment_disabled_request_queued_only");

  return { ok: errors.length === 0, errors, flags };
}
