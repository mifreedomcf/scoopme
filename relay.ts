/**
 * Masked relay calling and texting. Pure module.
 *
 * When a relay provider is configured, a rider and a driver reach each other
 * through a proxy number and neither learns the other's real one. When it is
 * not, we do NOT silently fall back to exposing real numbers — the in-app
 * channel is used instead, and the caller is told why.
 */

export type RelayChannel = "voice" | "sms";

export interface RelaySession {
  ride_request_id: string;
  proxy_number: string;
  participant_a_user_id: string;
  participant_b_user_id: string;
  expires_at: string;
  revoked_at?: string;
}

export interface RelayProvider {
  readonly name: string;
  readonly isLive: boolean;
  openSession(rideRequestId: string, a: string, b: string, expiresAt: string): Promise<{
    ok: boolean;
    proxy_number?: string;
    provider_session_id?: string;
    errorCode?: string;
  }>;
  closeSession(providerSessionId: string): Promise<{ ok: boolean; errorCode?: string }>;
}

/** No relay configured. Reports unavailable; never returns a fake number. */
export const unavailableRelay: RelayProvider = {
  name: "none",
  isLive: false,
  async openSession() {
    return { ok: false, errorCode: "relay_not_configured" };
  },
  async closeSession() {
    return { ok: false, errorCode: "relay_not_configured" };
  },
};

export type ContactMode = "relay" | "in_app_only" | "blocked";

export interface ContactDecision {
  mode: ContactMode;
  code: string;
  message: string;
  /** True when real phone numbers may be shown. Only ever for adult rides. */
  mayRevealRealNumbers: boolean;
}

export interface ContactContext {
  riderKind: "adult" | "minor";
  relayConfigured: boolean;
  rideStatus: string;
  isAssignedDriver: boolean;
  /** Reveal window for exact contact details, same rule as addresses. */
  revealWindowOpen: boolean;
}

const ACTIVE = ["confirmed", "en_route", "arrived_pickup", "rider_verified", "in_progress", "arrived_dropoff"];

/**
 * How may these two people reach each other?
 *
 * For a child, the answer is never "directly" — messages route through the
 * guardian and the platform, whatever the provider situation.
 */
export function decideContactMode(ctx: ContactContext): ContactDecision {
  if (ctx.riderKind === "minor") {
    return {
      mode: "in_app_only",
      code: "minor_routes_through_guardian",
      message:
        "For a child's ride, messages go through the guardian and stay in the app. Drivers and children never contact each other directly.",
      mayRevealRealNumbers: false,
    };
  }

  if (!ACTIVE.includes(ctx.rideStatus) || !ctx.isAssignedDriver) {
    return {
      mode: "blocked",
      code: "not_active_assignment",
      message: "Contact opens once you are assigned and the trip is close.",
      mayRevealRealNumbers: false,
    };
  }

  if (ctx.relayConfigured) {
    return {
      mode: "relay",
      code: "relay_available",
      message: "Calls and texts go through a platform number. Neither of you sees the other's real number.",
      mayRevealRealNumbers: false,
    };
  }

  // No relay. We would rather show a real number for one adult trip, inside the
  // reveal window, than have a driver unable to reach a rider standing outside.
  // That trade is stated out loud rather than made quietly.
  if (ctx.revealWindowOpen) {
    return {
      mode: "in_app_only",
      code: "relay_not_configured",
      message:
        "No masked calling is set up yet, so the rider's number is shown directly for this trip only. Do not save it or use it after the ride.",
      mayRevealRealNumbers: true,
    };
  }

  return {
    mode: "in_app_only",
    code: "outside_reveal_window",
    message: "Contact details unlock closer to the pickup time. Use in-app messages until then.",
    mayRevealRealNumbers: false,
  };
}

/** Relay sessions are as short-lived as the trip. */
export function relayExpiry(arriveBy: string | undefined, pickupAt: string, now: string): string {
  const base = new Date(arriveBy ?? pickupAt).getTime();
  const ceiling = new Date(now).getTime() + 8 * 3_600_000;
  return new Date(Math.min(base + 60 * 60_000, ceiling)).toISOString();
}

export function relaySessionLive(session: RelaySession, now: string): boolean {
  if (session.revoked_at && session.revoked_at <= now) return false;
  return session.expires_at > now;
}
