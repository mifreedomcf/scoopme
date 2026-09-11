import { describe, expect, it } from "vitest";
import {
  decideContactMode, relayExpiry, relaySessionLive, unavailableRelay,
  type ContactContext,
} from "@shared/relay";

const NOW = "2026-09-12T10:00:00Z";

function ctx(overrides: Partial<ContactContext> = {}): ContactContext {
  return {
    riderKind: "adult",
    relayConfigured: true,
    rideStatus: "en_route",
    isAssignedDriver: true,
    revealWindowOpen: true,
    ...overrides,
  };
}

describe("how two people may reach each other", () => {
  it("uses masked calling when a relay is configured", () => {
    const d = decideContactMode(ctx());
    expect(d.mode).toBe("relay");
    expect(d.mayRevealRealNumbers).toBe(false);
  });

  it("never allows direct contact on a child's ride, relay or not", () => {
    for (const relayConfigured of [true, false]) {
      const d = decideContactMode(ctx({ riderKind: "minor", relayConfigured }));
      expect(d.mode).toBe("in_app_only");
      expect(d.mayRevealRealNumbers).toBe(false);
      expect(d.code).toBe("minor_routes_through_guardian");
      expect(d.message).toContain("through the guardian");
    }
  });

  it("blocks contact before assignment and outside an active ride", () => {
    expect(decideContactMode(ctx({ isAssignedDriver: false })).mode).toBe("blocked");
    expect(decideContactMode(ctx({ rideStatus: "approved" })).mode).toBe("blocked");
    expect(decideContactMode(ctx({ rideStatus: "completed" })).mode).toBe("blocked");
  });

  it("says so plainly rather than silently exposing a number when no relay exists", () => {
    const d = decideContactMode(ctx({ relayConfigured: false }));
    expect(d.mode).toBe("in_app_only");
    expect(d.code).toBe("relay_not_configured");
    expect(d.mayRevealRealNumbers).toBe(true);
    expect(d.message).toContain("No masked calling is set up");
    expect(d.message).toContain("Do not save it");
  });

  it("keeps numbers hidden outside the reveal window even with no relay", () => {
    const d = decideContactMode(ctx({ relayConfigured: false, revealWindowOpen: false }));
    expect(d.mayRevealRealNumbers).toBe(false);
    expect(d.code).toBe("outside_reveal_window");
  });
});

describe("the relay provider seam", () => {
  it("reports unavailable and never invents a proxy number", async () => {
    expect(unavailableRelay.isLive).toBe(false);
    const opened = await unavailableRelay.openSession("ride-1", "a", "b", NOW);
    expect(opened.ok).toBe(false);
    expect(opened.proxy_number).toBeUndefined();
    expect(opened.errorCode).toBe("relay_not_configured");
  });
});

describe("relay session lifetime", () => {
  it("expires with the trip, capped", () => {
    const expiry = relayExpiry("2026-09-12T11:00:00Z", "2026-09-12T10:30:00Z", NOW);
    expect(new Date(expiry).getTime()).toBe(new Date("2026-09-12T12:00:00Z").getTime());
    const far = relayExpiry("2027-01-01T00:00:00Z", "2026-09-12T10:30:00Z", NOW);
    expect(new Date(far).getTime()).toBe(new Date(NOW).getTime() + 8 * 3_600_000);
  });

  it("treats a revoked or expired session as dead", () => {
    const base = {
      ride_request_id: "ride-1", proxy_number: "+15550100",
      participant_a_user_id: "a", participant_b_user_id: "b",
      expires_at: "2026-09-12T12:00:00Z",
    };
    expect(relaySessionLive(base, NOW)).toBe(true);
    expect(relaySessionLive({ ...base, revoked_at: "2026-09-12T09:00:00Z" }, NOW)).toBe(false);
    expect(relaySessionLive({ ...base, expires_at: "2026-09-12T09:00:00Z" }, NOW)).toBe(false);
  });
});
