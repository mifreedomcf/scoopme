/**
 * Milestone 5 acceptance criteria.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTrackingAccess, mayCollectLocation, trackingPayload } from "@shared/tracking";
import { decideSweep, DEFAULT_RETENTION_RULES, NEVER_SWEPT } from "@shared/retention";
import { decideContactMode, unavailableRelay } from "@shared/relay";
import { observeTrail, straightLineRouter } from "@shared/routing";
import { resolveConfig } from "@shared/flags";
import { FLAG_GATE_REQUIREMENTS } from "@shared/constants";
import { secureToken } from "@shared/ids";

const FUNCTIONS = join(process.cwd(), "base44", "functions");
const ENTITIES = join(process.cwd(), "base44", "entities");
const fn = (name: string) => readFileSync(join(FUNCTIONS, name, "entry.ts"), "utf8");
const entity = (file: string) => JSON.parse(readFileSync(join(ENTITIES, file), "utf8"));
const NOW = "2026-09-12T10:00:00Z";

const session = {
  ride_request_id: "ride-1",
  ride_status: "in_progress",
  consent: {
    ride_request_id: "ride-1", granted_by_user_id: "rider-1",
    granted_at: "2026-09-12T09:00:00Z", audiences: ["rider", "safety_staff", "dispatcher"] as never,
  },
  liveLocationEnabled: true,
  gatesSatisfied: true,
};

describe("acceptance: live location is off and gated", () => {
  it("defaults off and is blocked behind privacy and legal-document gates", () => {
    expect(resolveConfig(null).live_location_enabled).toBe(false);
    expect(FLAG_GATE_REQUIREMENTS.live_location_enabled).toContain("privacy_security");
    expect(FLAG_GATE_REQUIREMENTS.live_location_enabled).toContain("legal_documents");
  });

  it("refuses collection and reading while the flag is off", () => {
    expect(mayCollectLocation({ ...session, liveLocationEnabled: false }, NOW).allowed).toBe(false);
    expect(checkTrackingAccess(
      {
        token: "t".repeat(64), ride_request_id: "ride-1", audience: "rider",
        issued_to_user_id: "rider-1", issued_at: NOW, expires_at: "2026-09-12T12:00:00Z",
      },
      { ...session, liveLocationEnabled: false }, NOW,
    ).allowed).toBe(false);
  });

  it("checks the flag and the gates inside every location function", () => {
    for (const name of ["start-location-sharing", "record-location-ping", "read-tracking"]) {
      expect(fn(name), name).toContain("live_location_enabled");
      expect(fn(name), name).toContain("checkGatesForFlag");
    }
  });
});

describe("acceptance: precise location only in the minimum necessary window", () => {
  it("collects only while a ride is actually underway", () => {
    for (const status of ["approved", "offered", "claimed", "confirmed", "completed", "canceled", "waitlisted"]) {
      expect(mayCollectLocation({ ...session, ride_status: status }, NOW).code, status).toBe("ride_not_active");
    }
    expect(mayCollectLocation(session, NOW).allowed).toBe(true);
  });

  it("collects only after the grantor has agreed, and stops the moment they withdraw", () => {
    expect(mayCollectLocation({ ...session, consent: null }, NOW).code).toBe("no_consent");
    const withdrawn = { ...session, consent: { ...session.consent, revoked_at: "2026-09-12T09:59:00Z" } };
    expect(mayCollectLocation(withdrawn, NOW).code).toBe("consent_revoked");
  });

  it("accepts points only from the assigned driver", () => {
    const source = fn("record-location-ping");
    expect(source).toContain("assignment.driver_user_id !== ctx.principal.userId");
    expect(entity("location-event.jsonc").properties.recorded_by_user_id.description)
      .toContain("No other source is accepted");
  });

  it("lets only the rider or a verified guardian turn it on, never staff or the driver", () => {
    const source = fn("start-location-sharing");
    expect(source).toContain("Only the rider, or a child's verified guardian");
    expect(source).toContain('status: "verified"');
    expect(source).toContain("not_the_grantor");
  });
});

describe("acceptance: tracking links expire, are unguessable, rate-limited and audited", () => {
  it("mints 256-bit tokens that never repeat", () => {
    const tokens = new Set(Array.from({ length: 300 }, () => secureToken(32)));
    expect(tokens.size).toBe(300);
    for (const t of tokens) expect(t).toHaveLength(64);
    expect(fn("start-location-sharing")).toContain("secureToken(32)");
  });

  it("refuses an expired, revoked, or wrong-ride token", () => {
    const base = {
      token: "t".repeat(64), ride_request_id: "ride-1", audience: "rider" as const,
      issued_to_user_id: "rider-1", issued_at: "2026-09-12T09:00:00Z",
      expires_at: "2026-09-12T12:00:00Z",
    };
    expect(checkTrackingAccess({ ...base, expires_at: "2026-09-12T09:30:00Z" }, session, NOW).code).toBe("link_expired");
    expect(checkTrackingAccess({ ...base, revoked_at: "2026-09-12T09:30:00Z" }, session, NOW).code).toBe("link_revoked");
    expect(checkTrackingAccess({ ...base, ride_request_id: "other" }, session, NOW).code).toBe("link_other_ride");
  });

  it("refuses an audience the grantor never agreed to", () => {
    expect(checkTrackingAccess(
      {
        token: "t".repeat(64), ride_request_id: "ride-1", audience: "org_scheduler",
        issued_to_user_id: "", issued_at: NOW, expires_at: "2026-09-12T12:00:00Z",
      },
      session, NOW,
    ).code).toBe("audience_not_consented");
  });

  it("audits every read, allowed or denied, and gives a bad token the same answer as a revoked one", () => {
    const source = fn("read-tracking");
    expect(source).toContain('event_type: "location.read"');
    expect(source).toContain('outcome: verdict.allowed ? "allowed" : "denied"');
    expect(source).toContain("A bad token and a revoked token look identical from outside");
  });

  it("revokes every token the moment sharing is turned off", () => {
    const source = fn("stop-location-sharing");
    expect(source).toContain("TrackingLink.updateMany");
    expect(source).toContain("never refused");
  });
});

describe("acceptance: exact location stops being shown after completion", () => {
  it("returns a coarse point and no trail once the ride is over", () => {
    const points = [
      { point: { lat: 42.4300, lng: -82.9812 }, recorded_at: "2026-09-12T09:50:00Z" },
      { point: { lat: 42.4320, lng: -82.9790 }, recorded_at: "2026-09-12T09:59:00Z" },
    ];
    const verdict = checkTrackingAccess(
      {
        token: "t".repeat(64), ride_request_id: "ride-1", audience: "rider",
        issued_to_user_id: "rider-1", issued_at: NOW, expires_at: "2026-09-12T12:00:00Z",
      },
      { ...session, ride_status: "completed" }, NOW,
    );
    expect(verdict.coarseOnly).toBe(true);
    const payload = trackingPayload(points, verdict);
    expect(payload.precise).toBe(false);
    expect(payload.trail).toEqual([]);
    expect(payload.point).not.toEqual(points[1].point);
  });

  it("never hands over the whole route even while live", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      point: { lat: 42.43 + i * 0.001, lng: -82.98 }, recorded_at: NOW,
    }));
    const payload = trackingPayload(many, { allowed: true, code: "ok", message: "", coarseOnly: false });
    expect(payload.trail.length).toBeLessThanOrEqual(5);
  });
});

describe("acceptance: masked relay, or an honest in-app fallback", () => {
  it("never invents a proxy number when unconfigured", async () => {
    const opened = await unavailableRelay.openSession("ride-1", "a", "b", NOW);
    expect(opened.ok).toBe(false);
    expect(opened.proxy_number).toBeUndefined();
    expect(fn("open-relay-session")).toContain("rather than inventing a number");
  });

  it("keeps a child's ride in-app whatever the provider situation", () => {
    for (const relayConfigured of [true, false]) {
      const d = decideContactMode({
        riderKind: "minor", relayConfigured, rideStatus: "in_progress",
        isAssignedDriver: true, revealWindowOpen: true,
      });
      expect(d.mode).toBe("in_app_only");
      expect(d.mayRevealRealNumbers).toBe(false);
    }
  });

  it("states the trade-off out loud rather than quietly exposing a number", () => {
    const d = decideContactMode({
      riderKind: "adult", relayConfigured: false, rideStatus: "en_route",
      isAssignedDriver: true, revealWindowOpen: true,
    });
    expect(d.message).toContain("No masked calling is set up");
    expect(d.message).toContain("Do not save it");
  });
});

describe("acceptance: the trail informs people and decides nothing", () => {
  it("reports what was observed without a conclusion or an instruction", () => {
    const trail = [
      { point: { lat: 42.4302, lng: -82.9812 }, recorded_at: "2026-09-12T09:50:00Z" },
      { point: { lat: 42.60, lng: -83.50 }, recorded_at: "2026-09-12T09:59:00Z" },
    ];
    const o = observeTrail(trail, [{ lat: 42.4302, lng: -82.9812 }, { lat: 42.3506, lng: -83.0295 }], NOW);
    expect(o.kind).toBe("route_deviation");
    expect(o.description.toLowerCase()).not.toMatch(/danger|suspicious|call 911|cancel|police/);
  });

  it("wires the trail into the existing sweep without letting it move a ride", () => {
    const source = fn("ride-checkin-sweep");
    expect(source).toContain("observeTrail");
    expect(source).toContain("No conclusion has been drawn");
    for (const forbidden of ['status: "canceled"', 'status: "completed"', 'to_state: "canceled"']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("labels a straight-line estimate as an estimate rather than a route", async () => {
    expect(straightLineRouter.isLive).toBe(false);
    expect((await straightLineRouter.route({ lat: 42.43, lng: -82.98 }, { lat: 42.35, lng: -83.03 })).provider)
      .toBe("straight_line_estimate");
  });
});

describe("acceptance: retention runs, and holds beat it", () => {
  it("is off until an administrator turns it on", () => {
    expect(resolveConfig(null).retention_sweep_enabled).toBe(false);
    expect(fn("retention-sweep")).toContain("sweep_disabled");
  });

  it("expires precise location first and never touches audit, incident, or consent", () => {
    const location = DEFAULT_RETENTION_RULES.find((r) => r.entity === "LocationEvent")!;
    expect(location.retain_days).toBeLessThanOrEqual(7);
    for (const entity of ["AuditLog", "SafetyIncident", "ConsentRecord"]) {
      expect(NEVER_SWEPT).toContain(entity);
    }
  });

  it("skips a held record and deletes nothing when holds cannot be read", () => {
    const old = new Date(Date.now() - 999 * 86_400_000).toISOString();
    expect(decideSweep(
      { entity: "LocationEvent", id: "l1", anchor_value: old },
      DEFAULT_RETENTION_RULES,
      [{ scope_entity: "LocationEvent", scope_id: "l1", is_active: true }],
      "2026-09-12",
    ).code).toBe("under_hold");
    expect(decideSweep(
      { entity: "LocationEvent", id: "l1", anchor_value: old },
      DEFAULT_RETENTION_RULES, null, "2026-09-12",
    ).code).toBe("holds_unreadable");
    expect(fn("retention-sweep")).toContain("holds_unreadable");
  });

  it("anonymizes a ride rather than deleting the row, and stays idempotent", () => {
    const rule = DEFAULT_RETENTION_RULES.find((r) => r.entity === "RideRequest")!;
    expect(rule.action).toBe("anonymize");
    expect(fn("retention-sweep")).toContain("row.anonymized_at");
    expect(entity("ride-request.jsonc").properties.anonymized_at).toBeTruthy();
  });
});

describe("milestone 5 wiring", () => {
  it("ships the six new functions and the nightly automation", () => {
    const names = readdirSync(FUNCTIONS);
    for (const required of [
      "start-location-sharing", "record-location-ping", "read-tracking",
      "stop-location-sharing", "open-relay-session", "retention-sweep",
    ]) {
      expect(names, required).toContain(required);
    }
    const config = JSON.parse(
      readFileSync(join(FUNCTIONS, "retention-sweep", "function.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    );
    expect(config.automations[0].schedule_type).toBe("cron");
    expect(config.automations[0].cron_expression.split(" ")).toHaveLength(5);
  });

  it("field-secures coordinates and tokens", () => {
    const location = entity("location-event.jsonc");
    expect(location.properties.latitude.rls?.read).toBeTruthy();
    expect(location.properties.longitude.rls?.read).toBeTruthy();
    expect(location.rls.update).toBe(false);
    expect(location.rls.delete).toBe(false);
    expect(entity("tracking-link.jsonc").properties.token.rls?.read).toBeTruthy();
    expect(entity("relay-session.jsonc").properties.proxy_number.rls?.read).toBeTruthy();
  });

  it("keeps location out of reports entirely", () => {
    const reporting = readFileSync(join(process.cwd(), "base44", "shared", "reporting.ts"), "utf8");
    for (const forbidden of ["latitude", "longitude", "LocationEvent", "tracking"]) {
      expect(reporting.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
