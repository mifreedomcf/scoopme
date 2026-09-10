/**
 * Shared constants for Scoop Me. Pure module: no npm imports, no I/O.
 * Imported by backend functions (Deno) and by the Vitest suite.
 */

export const ROLES = [
  "adult_rider",
  "guardian",
  "volunteer_driver",
  "org_scheduler",
  "org_admin",
  "dispatcher",
  "safety_staff",
  "platform_admin",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles a user may take on without staff approval. Everything else needs review. */
export const SELF_SERVE_ROLES: Role[] = ["adult_rider"];

/** Roles that can act on other people's ride records. */
export const STAFF_ROLES: Role[] = ["dispatcher", "safety_staff", "platform_admin"];

export const RIDE_STATES = [
  "draft",
  "submitted",
  "eligibility_review",
  "awaiting_consent",
  "approved",
  "offered",
  "claimed",
  "confirmed",
  "en_route",
  "arrived_pickup",
  "rider_verified",
  "in_progress",
  "arrived_dropoff",
  "handoff_verified",
  "completed",
  "waitlisted",
  "canceled",
  "driver_canceled",
  "rider_no_show",
  "failed_handoff",
  "incident_hold",
  "closed_by_admin",
] as const;
export type RideState = (typeof RIDE_STATES)[number];

/** States in which a ride is finished and must not move again except by admin closure. */
export const TERMINAL_STATES: RideState[] = ["completed", "canceled", "closed_by_admin"];

/**
 * Safe defaults. These are what the server falls back to if SystemConfig is
 * missing or unreadable. Every default is the restrictive option.
 */
export const SAFE_DEFAULT_CONFIG = {
  config_key: "active",
  operator_legal_name: "Pilot Operator — To Be Confirmed",
  brand_name: "Scoop Me",
  brand_tagline: "Free scheduled rides to community resources.",
  support_email: "",
  support_phone: "",
  safety_phone: "",

  pilot_mode: true,
  service_area_label: "City of Detroit, Michigan",
  service_area_city: "Detroit",
  service_area_state: "MI",
  allowed_destination_zip_codes: ["48205"],
  allowed_pickup_zip_codes: [] as string[],

  adult_rides_enabled: true,
  minor_rides_enabled: false,
  same_day_rides_enabled: false,
  direct_driver_tips_enabled: false,
  platform_donations_enabled: false,
  organization_in_kind_contributions_enabled: true,
  live_location_enabled: false,
  ride_fulfillment_enabled: false,

  background_check_provider_mode: "mock_pending_review",
  geocoder_provider_mode: "mock",

  minimum_request_lead_hours: 24,
  minimum_driver_age: 21,
  minimum_minor_transport_driver_age: 25,
  driver_tip_annual_cap_cents: 0,

  max_volunteer_travel_miles: 15,
  vehicle_inspection_age_years: 5,
  ride_request_rate_limit_per_day: 5,

  legal_content_approved: false,
  config_version: 1,
};

export type SystemConfigShape = typeof SAFE_DEFAULT_CONFIG & Record<string, unknown>;

/** Absolute floors the server refuses to go below, whatever an admin types. */
export const HARD_FLOORS = {
  minimum_driver_age: 21,
  minimum_minor_transport_driver_age: 25,
};

/**
 * Which launch-gate categories must be complete and unexpired before a flag
 * may be turned on. Enforced in admin-update-config, not in the UI.
 */
export const FLAG_GATE_REQUIREMENTS: Record<string, string[]> = {
  ride_fulfillment_enabled: [
    "regulatory",
    "insurance",
    "driver_auto_policy",
    "legal_documents",
    "background_checks",
    "mvr_monitoring",
    "privacy_security",
    "support_coverage",
    "partner_mou",
  ],
  minor_rides_enabled: [
    "regulatory",
    "insurance",
    "driver_auto_policy",
    "legal_documents",
    "background_checks",
    "mvr_monitoring",
    "child_safeguarding",
    "child_restraint",
    "privacy_security",
    "support_coverage",
  ],
  live_location_enabled: ["privacy_security", "legal_documents"],
  platform_donations_enabled: ["payments_tax", "legal_documents", "privacy_security"],
  direct_driver_tips_enabled: ["payments_tax", "legal_documents", "insurance", "regulatory"],
  organization_in_kind_contributions_enabled: ["legal_documents"],
};

/** Gates that no emergency override may bypass. */
export const NON_OVERRIDABLE_GATE_CATEGORIES = [
  "background_checks",
  "child_safeguarding",
  "child_restraint",
  "insurance",
];

export const RESOURCE_CATEGORIES = [
  "food_pantry",
  "free_fridge",
  "mutual_aid_supplies",
  "clothing",
  "social_services",
  "education_program",
  "workforce",
  "non_emergency_appointment",
  "community_event",
  "other",
] as const;

/**
 * Fields that must never leave the server inside an offer, notification,
 * export, or any payload shown to an unassigned driver.
 */
export const NEVER_MINIMIZED_SAFE_FIELDS = [
  "pickup_address",
  "destination_address",
  "pickup_latitude",
  "pickup_longitude",
  "destination_latitude",
  "destination_longitude",
  "contact_phone",
  "verification_code",
  "operational_notes",
  "legal_first_name",
  "legal_last_name",
  "date_of_birth",
  "license_number_last4",
  "narrative",
];
