/**
 * Live location sharing. Pure module.
 *
 * Precise location is the most dangerous data this platform touches, so the
 * rules here are narrow on purpose:
 *
 *   - collected only during an active ride, and only after consent
 *   - shared only with the people who actually need it for THIS ride
 *   - reached through an unguessable token that expires
 *   - stops being precise the moment the ride ends
 *   - every access is logged
 *
 * Nothing in this module is reachable while `live_location_enabled` is false,
 * which is its default and which is gated behind the privacy and legal-document
 * launch items.
 */
import { coarsenPoint, type LatLng } from "./geo.ts";

export type TrackingAudience = "rider" | "guardian" | "org_scheduler" | "assigned_driver" | "safety_staff" | "dispatcher";

/** States in which precise location may be collected at all. */
export const TRACKING_ACTIVE_STATES = [
  "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff",
];

/** How long after the ride ends a tracking link keeps working. */
export const GRACE_MINUTES_AFTER_COMPLETION = 10;
/** Hard ceiling on any tracking link, whatever else happens. */
export const MAX_LINK_LIFETIME_MINUTES = 8 * 60;
/** Minimum seconds between accepted pings, to bound how fine the trail is. */
export const MIN_PING_INTERVAL_SECONDS = 20;
/** Reads of one tracking token allowed per minute. */
export const TRACKING_READ_RATE_PER_MINUTE = 30;

export interface TrackingConsent {
  ride_request_id: string;
  /** The rider, or the verified guardian for a child. */
  granted_by_user_id: string;
  granted_at: string;
  revoked_at?: string;
  /** Audiences the grantor agreed to. An org scheduler is opt-in, never assumed. */
  audiences: TrackingAudience[];
}

export interface TrackingSessionState {
  ride_request_id: string;
  ride_status: string;
  started_at?: string;
  ended_at?: string;
  consent?: TrackingConsent | null;
  liveLocationEnabled: boolean;
  gatesSatisfied: boolean;
}

export interface CollectionVerdict {
  allowed: boolean;
  code: string;
  message: string;
}

/**
 * May we collect a precise point right now? Called on every ping; a consent
 * withdrawn thirty seconds ago stops the next one.
 */
export function mayCollectLocation(state: TrackingSessionState, now: string): CollectionVerdict {
  if (!state.liveLocationEnabled) {
    return { allowed: false, code: "live_location_disabled", message: "Live location is switched off." };
  }
  if (!state.gatesSatisfied) {
    return { allowed: false, code: "gate_incomplete", message: "Live location is blocked by incomplete launch gates." };
  }
  if (!TRACKING_ACTIVE_STATES.includes(state.ride_status)) {
    return {
      allowed: false,
      code: "ride_not_active",
      message: "Location is only collected while a ride is actually underway.",
    };
  }
  if (!state.consent) {
    return { allowed: false, code: "no_consent", message: "Nobody has agreed to location being shared on this ride." };
  }
  if (state.consent.revoked_at && state.consent.revoked_at <= now) {
    return { allowed: false, code: "consent_revoked", message: "Location sharing was turned off for this ride." };
  }
  if (state.ended_at && state.ended_at <= now) {
    return { allowed: false, code: "session_ended", message: "This tracking session has ended." };
  }
  return { allowed: true, code: "ok", message: "Collection permitted." };
}

export interface PingCheck {
  accepted: boolean;
  code: string;
  message: string;
}

/** Reject a ping that arrives too fast, or one that is obviously not a coordinate. */
export function acceptPing(point: LatLng, lastPingAt: string | undefined, now: string): PingCheck {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
    return { accepted: false, code: "invalid_point", message: "That is not a location." };
  }
  if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
    return { accepted: false, code: "invalid_point", message: "That is not a location." };
  }
  if (lastPingAt) {
    const gap = (new Date(now).getTime() - new Date(lastPingAt).getTime()) / 1000;
    if (!Number.isFinite(gap) || gap < MIN_PING_INTERVAL_SECONDS) {
      return { accepted: false, code: "too_frequent", message: "Slow down." };
    }
  }
  return { accepted: true, code: "ok", message: "Accepted." };
}

export interface TrackingLinkState {
  token: string;
  ride_request_id: string;
  audience: TrackingAudience;
  issued_to_user_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at?: string;
  reads_in_current_minute?: number;
}

export interface LinkAccessVerdict {
  allowed: boolean;
  code: string;
  message: string;
  /** True when the ride is over: show a coarse last-known point, not a live one. */
  coarseOnly: boolean;
}

/**
 * Decide whether a tracking token may be read, and at what fidelity.
 *
 * After a ride ends, a link keeps working briefly so someone who was watching
 * is not cut off mid-glance — but it stops being precise.
 */
export function checkTrackingAccess(
  link: TrackingLinkState,
  session: TrackingSessionState,
  now: string,
): LinkAccessVerdict {
  const deny = (code: string, message: string): LinkAccessVerdict =>
    ({ allowed: false, code, message, coarseOnly: true });

  if (!session.liveLocationEnabled || !session.gatesSatisfied) {
    return deny("live_location_disabled", "Live location is switched off.");
  }
  if (link.revoked_at && link.revoked_at <= now) {
    return deny("link_revoked", "This link has been turned off.");
  }
  if (link.expires_at <= now) {
    return deny("link_expired", "This link has expired.");
  }
  if (link.ride_request_id !== session.ride_request_id) {
    return deny("link_other_ride", "This link is not for that ride.");
  }
  if (!session.consent) {
    return deny("no_consent", "Location is not being shared on this ride.");
  }
  if (session.consent.revoked_at && session.consent.revoked_at <= now) {
    return deny("consent_revoked", "Location sharing was turned off for this ride.");
  }
  if (!session.consent.audiences.includes(link.audience)) {
    return deny("audience_not_consented", "You were not included in what was agreed for this ride.");
  }
  if ((link.reads_in_current_minute ?? 0) >= TRACKING_READ_RATE_PER_MINUTE) {
    return deny("rate_limited", "Too many refreshes. Wait a moment.");
  }

  const rideOver = !TRACKING_ACTIVE_STATES.includes(session.ride_status);
  if (rideOver) {
    return {
      allowed: true,
      code: "coarse_only",
      message: "This ride has finished. Showing roughly where it ended.",
      coarseOnly: true,
    };
  }
  return { allowed: true, code: "ok", message: "Live.", coarseOnly: false };
}

/** Expiry for a newly minted link: the trip window plus a short grace, capped. */
export function linkExpiry(pickupAt: string, arriveBy: string | undefined, now: string): string {
  const base = new Date(arriveBy ?? pickupAt).getTime();
  const withGrace = base + GRACE_MINUTES_AFTER_COMPLETION * 60_000;
  const ceiling = new Date(now).getTime() + MAX_LINK_LIFETIME_MINUTES * 60_000;
  return new Date(Math.min(withGrace, ceiling)).toISOString();
}

/**
 * Build the payload for a tracking read. A finished ride yields a coarsened
 * point and no trail at all.
 */
export function trackingPayload(
  points: { point: LatLng; recorded_at: string }[],
  verdict: LinkAccessVerdict,
): { point: LatLng | null; recorded_at: string | null; precise: boolean; trail: { point: LatLng; recorded_at: string }[] } {
  const latest = points.length > 0 ? points[points.length - 1] : null;
  if (!latest) return { point: null, recorded_at: null, precise: false, trail: [] };
  if (verdict.coarseOnly) {
    return {
      point: coarsenPoint(latest.point),
      recorded_at: latest.recorded_at,
      precise: false,
      trail: [],
    };
  }
  return {
    point: latest.point,
    recorded_at: latest.recorded_at,
    precise: true,
    // A short tail only. We do not hand anyone the whole route.
    trail: points.slice(-5),
  };
}

/** Who a rider is offered as tracking audiences. Staff are always included. */
export function defaultAudiences(riderKind: string, hasOrgSponsor: boolean): TrackingAudience[] {
  const base: TrackingAudience[] = ["safety_staff", "dispatcher"];
  if (riderKind === "minor") return [...base, "guardian"];
  return hasOrgSponsor ? [...base, "rider"] : [...base, "rider"];
}
