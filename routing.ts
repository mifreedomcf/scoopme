/**
 * Routing, and what a location trail can and cannot tell us. Pure module.
 *
 * These detectors feed the escalation timers. They describe what was observed —
 * "the car has not moved for 18 minutes", "this is 2.4 miles off the expected
 * line" — and never conclude anything about why. A person reads the alert.
 */
import { distanceMiles, type LatLng } from "./geo.ts";

export interface RoutePoint {
  point: LatLng;
  recorded_at: string;
}

/** The contract a routing provider implements. Swappable, like the geocoder. */
export interface RoutingProvider {
  readonly name: string;
  readonly isLive: boolean;
  route(from: LatLng, to: LatLng): Promise<RouteEstimate>;
}

export interface RouteEstimate {
  status: "ok" | "provider_unavailable" | "no_route";
  provider: string;
  distance_miles?: number;
  duration_minutes?: number;
  /** Coarse polyline for deviation checks. Never stored as a rider's trail. */
  corridor?: LatLng[];
}

/**
 * No routing credentials configured. Returns a straight-line estimate clearly
 * labelled as such, rather than pretending to know the roads.
 */
export const straightLineRouter: RoutingProvider = {
  name: "straight_line_estimate",
  isLive: false,
  async route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    const miles = distanceMiles(from, to);
    return {
      status: "ok",
      provider: "straight_line_estimate",
      distance_miles: Math.round(miles * 10) / 10,
      // Deliberately generous: an estimate that is wrong should be wrong in the
      // direction of not raising a false alarm.
      duration_minutes: Math.round((miles / 18) * 60) + 10,
      corridor: [from, to],
    };
  },
};

/** Live adapter. Not implemented rather than stubbed with a fake success. */
export function createLiveRouter(providerName: string, apiKey: string | undefined): RoutingProvider {
  return {
    name: providerName,
    isLive: Boolean(apiKey),
    async route(): Promise<RouteEstimate> {
      return { status: "provider_unavailable", provider: providerName };
    },
  };
}

/** Perpendicular-ish distance from a point to a segment, in miles. */
export function distanceToSegment(point: LatLng, a: LatLng, b: LatLng): number {
  const toXY = (p: LatLng) => ({ x: p.lng * Math.cos((p.lat * Math.PI) / 180), y: p.lat });
  const P = toXY(point);
  const A = toXY(a);
  const B = toXY(b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distanceMiles(point, a);
  let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nearestLat = a.lat + t * (b.lat - a.lat);
  const nearestLng = a.lng + t * (b.lng - a.lng);
  return distanceMiles(point, { lat: nearestLat, lng: nearestLng });
}

export function distanceToCorridor(point: LatLng, corridor: LatLng[]): number {
  if (corridor.length === 0) return Number.POSITIVE_INFINITY;
  if (corridor.length === 1) return distanceMiles(point, corridor[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < corridor.length - 1; i += 1) {
    best = Math.min(best, distanceToSegment(point, corridor[i], corridor[i + 1]));
  }
  return best;
}

export const DEVIATION_THRESHOLD_MILES = 2.5;
export const STOP_RADIUS_MILES = 0.1;
export const UNEXPECTED_STOP_MINUTES = 12;

export interface TrailObservation {
  kind: "route_deviation" | "unexpected_stop" | "none";
  /** What was seen. Never why. */
  description: string;
  miles_off_route?: number;
  stopped_minutes?: number;
}

/**
 * Look at a trail and describe anything odd. Returns `none` freely — a quiet
 * detector that people trust beats a noisy one they learn to ignore.
 */
export function observeTrail(
  trail: RoutePoint[],
  corridor: LatLng[],
  now: string,
): TrailObservation {
  if (trail.length === 0) return { kind: "none", description: "No location data." };

  const latest = trail[trail.length - 1];

  // Off the expected line by a wide margin.
  if (corridor.length >= 2) {
    const off = distanceToCorridor(latest.point, corridor);
    if (Number.isFinite(off) && off > DEVIATION_THRESHOLD_MILES) {
      return {
        kind: "route_deviation",
        description: `Currently about ${off.toFixed(1)} miles from the expected line between pickup and destination.`,
        miles_off_route: Math.round(off * 10) / 10,
      };
    }
  }

  // Not moving. Traffic and a closed road both look like this, which is exactly
  // why this is a prompt for a phone call and not a conclusion.
  const anchor = trail.find(
    (p) => distanceMiles(p.point, latest.point) <= STOP_RADIUS_MILES,
  );
  if (anchor) {
    const minutes = (new Date(now).getTime() - new Date(anchor.recorded_at).getTime()) / 60_000;
    if (Number.isFinite(minutes) && minutes >= UNEXPECTED_STOP_MINUTES) {
      return {
        kind: "unexpected_stop",
        description: `Has stayed within ${STOP_RADIUS_MILES} miles of the same spot for about ${Math.round(minutes)} minutes.`,
        stopped_minutes: Math.round(minutes),
      };
    }
  }

  return { kind: "none", description: "Nothing unusual in the trail." };
}
