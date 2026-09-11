import { describe, expect, it } from "vitest";
import {
  acceptPing, checkTrackingAccess, defaultAudiences, GRACE_MINUTES_AFTER_COMPLETION,
  linkExpiry, MAX_LINK_LIFETIME_MINUTES, mayCollectLocation, MIN_PING_INTERVAL_SECONDS,
  TRACKING_READ_RATE_PER_MINUTE, trackingPayload,
  type TrackingLinkState, type TrackingSessionState,
} from "@shared/tracking";

const NOW = "2026-09-12T10:00:00Z";

function session(overrides: Partial<TrackingSessionState> = {}): TrackingSessionState {
  return {
    ride_request_id: "ride-1",
    ride_status: "in_progress",
    started_at: "2026-09-12T09:30:00Z",
    consent: {
      ride_request_id: "ride-1",
      granted_by_user_id: "rider-1",
      granted_at: "2026-09-12T09:00:00Z",
      audiences: ["rider", "safety_staff", "dispatcher"],
    },
    liveLocationEnabled: true,
    gatesSatisfied: true,
    ...overrides,
  };
}

function link(overrides: Partial<TrackingLinkState> = {}): TrackingLinkState {
  return {
    token: "a".repeat(64),
    ride_request_id: "ride-1",
    audience: "rider",
    issued_to_user_id: "rider-1",
    issued_at: "2026-09-12T09:00:00Z",
    expires_at: "2026-09-12T12:00:00Z",
    reads_in_current_minute: 0,
    ...overrides,
  };
}

describe("when location may be collected", () => {
  it("allows it during an active ride with live consent", () => {
    expect(mayCollectLocation(session(), NOW).allowed).toBe(true);
  });

  it("refuses while the flag is off or the gates are incomplete", () => {
    expect(mayCollectLocation(session({ liveLocationEnabled: false }), NOW).code).toBe("live_location_disabled");
    expect(mayCollectLocation(session({ gatesSatisfied: false }), NOW).code).toBe("gate_incomplete");
  });

  it("refuses outside the active part of a ride", () => {
    for (const status of ["approved", "offered", "claimed", "confirmed", "completed", "canceled"]) {
      expect(mayCollectLocation(session({ ride_status: status }), NOW).code, status).toBe("ride_not_active");
    }
  });

  it("refuses without consent, and stops the moment consent is withdrawn", () => {
    expect(mayCollectLocation(session({ consent: null }), NOW).code).toBe("no_consent");
    const withdrawn = session();
    withdrawn.consent!.revoked_at = "2026-09-12T09:59:30Z";
    expect(mayCollectLocation(withdrawn, NOW).code).toBe("consent_revoked");
  });

  it("refuses once the session has ended", () => {
    expect(mayCollectLocation(session({ ended_at: "2026-09-12T09:59:00Z" }), NOW).code).toBe("session_ended");
  });
});

describe("accepting a ping", () => {
  it("rejects nonsense coordinates", () => {
    expect(acceptPing({ lat: Number.NaN, lng: 0 }, undefined, NOW).accepted).toBe(false);
    expect(acceptPing({ lat: 120, lng: 0 }, undefined, NOW).code).toBe("invalid_point");
    expect(acceptPing({ lat: 0, lng: 300 }, undefined, NOW).code).toBe("invalid_point");
  });

  it("bounds how fine the trail can get", () => {
    const justNow = new Date(new Date(NOW).getTime() - (MIN_PING_INTERVAL_SECONDS - 5) * 1000).toISOString();
    expect(acceptPing({ lat: 42.4, lng: -83 }, justNow, NOW).code).toBe("too_frequent");
    const earlier = new Date(new Date(NOW).getTime() - 60_000).toISOString();
    expect(acceptPing({ lat: 42.4, lng: -83 }, earlier, NOW).accepted).toBe(true);
  });
});

describe("reading through a token", () => {
  it("allows a consented audience during an active ride, precisely", () => {
    const v = checkTrackingAccess(link(), session(), NOW);
    expect(v.allowed).toBe(true);
    expect(v.coarseOnly).toBe(false);
  });

  it("refuses an expired or revoked token", () => {
    expect(checkTrackingAccess(link({ expires_at: "2026-09-12T09:00:00Z" }), session(), NOW).code).toBe("link_expired");
    expect(checkTrackingAccess(link({ revoked_at: "2026-09-12T09:30:00Z" }), session(), NOW).code).toBe("link_revoked");
  });

  it("refuses a token for another ride", () => {
    expect(checkTrackingAccess(link({ ride_request_id: "ride-2" }), session(), NOW).code).toBe("link_other_ride");
  });

  it("refuses an audience the grantor did not agree to", () => {
    const v = checkTrackingAccess(link({ audience: "org_scheduler" }), session(), NOW);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("audience_not_consented");
  });

  it("stops the instant consent is withdrawn, not at token expiry", () => {
    const withdrawn = session();
    withdrawn.consent!.revoked_at = "2026-09-12T09:59:00Z";
    expect(checkTrackingAccess(link(), withdrawn, NOW).code).toBe("consent_revoked");
  });

  it("rate limits refreshes per token", () => {
    const v = checkTrackingAccess(link({ reads_in_current_minute: TRACKING_READ_RATE_PER_MINUTE }), session(), NOW);
    expect(v.code).toBe("rate_limited");
  });

  it("goes coarse once the ride is over rather than cutting off mid-glance", () => {
    const v = checkTrackingAccess(link(), session({ ride_status: "completed" }), NOW);
    expect(v.allowed).toBe(true);
    expect(v.coarseOnly).toBe(true);
  });

  it("refuses everything if the flag goes off mid-ride", () => {
    expect(checkTrackingAccess(link(), session({ liveLocationEnabled: false }), NOW).allowed).toBe(false);
  });
});

describe("what a reader gets back", () => {
  const points = [
    { point: { lat: 42.4300, lng: -82.9812 }, recorded_at: "2026-09-12T09:50:00Z" },
    { point: { lat: 42.4310, lng: -82.9800 }, recorded_at: "2026-09-12T09:55:00Z" },
    { point: { lat: 42.4320, lng: -82.9790 }, recorded_at: "2026-09-12T09:59:00Z" },
  ];

  it("gives a precise point and only a short tail during the ride", () => {
    const payload = trackingPayload(points, { allowed: true, code: "ok", message: "", coarseOnly: false });
    expect(payload.precise).toBe(true);
    expect(payload.point).toEqual(points[2].point);
    expect(payload.trail.length).toBeLessThanOrEqual(5);
  });

  it("coarsens the point and gives no trail at all once the ride is over", () => {
    const payload = trackingPayload(points, { allowed: true, code: "coarse_only", message: "", coarseOnly: true });
    expect(payload.precise).toBe(false);
    expect(payload.trail).toEqual([]);
    expect(payload.point).not.toEqual(points[2].point);
  });

  it("returns nothing when there is nothing", () => {
    const payload = trackingPayload([], { allowed: true, code: "ok", message: "", coarseOnly: false });
    expect(payload.point).toBeNull();
  });
});

describe("link lifetime and audiences", () => {
  it("expires with the trip plus a short grace, capped absolutely", () => {
    const expiry = linkExpiry("2026-09-12T10:00:00Z", "2026-09-12T11:00:00Z", NOW);
    expect(new Date(expiry).getTime()).toBe(new Date("2026-09-12T11:00:00Z").getTime() + GRACE_MINUTES_AFTER_COMPLETION * 60_000);

    const farFuture = linkExpiry("2027-01-01T10:00:00Z", undefined, NOW);
    expect(new Date(farFuture).getTime())
      .toBe(new Date(NOW).getTime() + MAX_LINK_LIFETIME_MINUTES * 60_000);
  });

  it("gives a child's ride the guardian, never the child", () => {
    const audiences = defaultAudiences("minor", false);
    expect(audiences).toContain("guardian");
    expect(audiences).not.toContain("rider");
  });

  it("never includes an organization scheduler by default", () => {
    expect(defaultAudiences("adult", true)).not.toContain("org_scheduler");
  });
});
