/**
 * Geography and service-area validation. Pure module.
 *
 * Design rule from the brief: a ZIP code alone is NOT sufficient for the final
 * geography check. A point is only ever marked in_service_area when a real
 * boundary polygon is loaded AND a live geocoder resolved the address. In every
 * other case the request is flagged for a human, never silently approved.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export type GeoStatus =
  | "unvalidated"
  | "in_service_area"
  | "outside_service_area"
  | "unresolvable"
  | "manual_review";

export interface GeocodeResult {
  status: "ok" | "ambiguous" | "not_found" | "provider_unavailable";
  normalizedAddress?: string;
  point?: LatLng;
  zip?: string;
  city?: string;
  state?: string;
  /** Coarse label safe to show an unassigned driver, e.g. "Near Gratiot & Conner". */
  areaLabel?: string;
  provider: string;
}

/** The contract every geocoder adapter implements. Swap providers without touching callers. */
export interface GeocoderProvider {
  readonly name: string;
  readonly isLive: boolean;
  geocode(address: string): Promise<GeocodeResult>;
}

/**
 * PLACEHOLDER BOUNDARY — NOT the legal Detroit city limit.
 *
 * This coarse ring is used only to REJECT points that are obviously far outside
 * the region. It can never be used to APPROVE a point as inside Detroit.
 * Replace it by loading the City of Detroit boundary GeoJSON through
 * admin settings before ride fulfillment is enabled.
 */
export const DETROIT_COARSE_RING: LatLng[] = [
  { lat: 42.4525, lng: -83.2875 },
  { lat: 42.4525, lng: -82.9100 },
  { lat: 42.2550, lng: -82.9100 },
  { lat: 42.2550, lng: -83.2875 },
];

export interface BoundarySource {
  /** True only when an authoritative municipal boundary has been loaded. */
  isAuthoritative: boolean;
  ring: LatLng[];
  label: string;
}

export const PLACEHOLDER_BOUNDARY: BoundarySource = {
  isAuthoritative: false,
  ring: DETROIT_COARSE_RING,
  label: "Coarse placeholder ring — replace with the City of Detroit boundary",
};

/** Standard ray-casting point-in-polygon. */
export function pointInRing(point: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Great-circle distance in statute miles. */
export function distanceMiles(a: LatLng, b: LatLng): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface ServiceAreaInput {
  geocode: GeocodeResult;
  boundary: BoundarySource;
  /** Point kind changes which ZIP allowlist applies. */
  kind: "pickup" | "destination";
  allowedDestinationZips: string[];
  allowedPickupZips: string[];
  serviceAreaCity: string;
  serviceAreaState: string;
}

export interface ServiceAreaVerdict {
  status: GeoStatus;
  /** Deterministic reasons, safe to show staff and to log. */
  reasons: string[];
  /** True when a dispatcher must look at this before the ride can be approved. */
  requiresHumanReview: boolean;
}

/**
 * The single service-area decision point. Called server-side on every request;
 * the client's opinion about geography is never trusted.
 */
export function validateServiceArea(input: ServiceAreaInput): ServiceAreaVerdict {
  const reasons: string[] = [];
  const { geocode, boundary, kind } = input;

  if (geocode.status === "provider_unavailable" || !geocode.provider || geocode.provider === "mock") {
    reasons.push("geocoder_not_live");
  }
  if (geocode.status === "not_found") {
    return { status: "unresolvable", reasons: ["address_not_found"], requiresHumanReview: true };
  }
  if (geocode.status === "ambiguous") {
    reasons.push("address_ambiguous");
  }

  const zip = geocode.zip ?? "";
  const allowList = kind === "destination" ? input.allowedDestinationZips : input.allowedPickupZips;

  // ZIP is a fast reject, never an approval.
  if (kind === "destination") {
    if (allowList.length > 0 && !allowList.includes(zip)) {
      return {
        status: "outside_service_area",
        reasons: ["destination_zip_not_in_pilot"],
        requiresHumanReview: false,
      };
    }
  } else if (allowList.length > 0 && !allowList.includes(zip)) {
    return {
      status: "outside_service_area",
      reasons: ["pickup_zip_not_allowed"],
      requiresHumanReview: false,
    };
  }

  if (geocode.city && geocode.city.toLowerCase() !== input.serviceAreaCity.toLowerCase()) {
    return { status: "outside_service_area", reasons: ["city_outside_service_area"], requiresHumanReview: false };
  }
  if (geocode.state && geocode.state.toUpperCase() !== input.serviceAreaState.toUpperCase()) {
    return { status: "outside_service_area", reasons: ["state_outside_service_area"], requiresHumanReview: false };
  }

  if (!geocode.point) {
    return { status: "manual_review", reasons: [...reasons, "no_coordinates"], requiresHumanReview: true };
  }

  const insideRing = pointInRing(geocode.point, boundary.ring);
  if (!insideRing) {
    return { status: "outside_service_area", reasons: ["point_outside_boundary"], requiresHumanReview: false };
  }

  // Inside the ring, but the ring is not authoritative and/or the geocoder is a
  // mock. We refuse to call that "in service area" — a human confirms.
  if (!boundary.isAuthoritative) reasons.push("boundary_not_authoritative");
  if (reasons.length > 0) {
    return { status: "manual_review", reasons, requiresHumanReview: true };
  }

  return { status: "in_service_area", reasons: ["boundary_confirmed"], requiresHumanReview: false };
}

/** Coarsen a point for display to an unassigned driver: ~0.5 mile grid. */
export function coarsenPoint(point: LatLng): LatLng {
  const round = (n: number, step: number) => Math.round(n / step) * step;
  return { lat: round(point.lat, 0.0075), lng: round(point.lng, 0.0075) };
}
