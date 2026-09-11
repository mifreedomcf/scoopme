import { describe, expect, it } from "vitest";
import {
  createLiveRouter, DEVIATION_THRESHOLD_MILES, distanceToCorridor, distanceToSegment,
  observeTrail, straightLineRouter, UNEXPECTED_STOP_MINUTES, type RoutePoint,
} from "@shared/routing";

const PICKUP = { lat: 42.4302, lng: -82.9812 };
const DEST = { lat: 42.3506, lng: -83.0295 };
const CORRIDOR = [PICKUP, DEST];
const NOW = "2026-09-12T10:00:00Z";

const at = (minutesAgo: number) => new Date(new Date(NOW).getTime() - minutesAgo * 60_000).toISOString();

describe("the routing provider seam", () => {
  it("labels a straight-line estimate as an estimate", async () => {
    const r = await straightLineRouter.route(PICKUP, DEST);
    expect(straightLineRouter.isLive).toBe(false);
    expect(r.provider).toBe("straight_line_estimate");
    expect(r.distance_miles).toBeGreaterThan(3);
    expect(r.duration_minutes).toBeGreaterThan(0);
  });

  it("reports unavailable rather than faking a route when unconfigured", async () => {
    const live = createLiveRouter("some_provider", undefined);
    expect(live.isLive).toBe(false);
    expect((await live.route(PICKUP, DEST)).status).toBe("provider_unavailable");
  });
});

describe("distance to a corridor", () => {
  it("is zero-ish on the line and grows off it", () => {
    const midpoint = { lat: (PICKUP.lat + DEST.lat) / 2, lng: (PICKUP.lng + DEST.lng) / 2 };
    expect(distanceToCorridor(midpoint, CORRIDOR)).toBeLessThan(0.2);
    expect(distanceToCorridor({ lat: 42.55, lng: -83.4 }, CORRIDOR)).toBeGreaterThan(DEVIATION_THRESHOLD_MILES);
  });

  it("handles a degenerate segment and an empty corridor", () => {
    expect(distanceToSegment(PICKUP, DEST, DEST)).toBeGreaterThan(0);
    expect(distanceToCorridor(PICKUP, [])).toBe(Number.POSITIVE_INFINITY);
    expect(distanceToCorridor(PICKUP, [PICKUP])).toBeLessThan(0.01);
  });
});

describe("observing a trail", () => {
  it("says nothing when a ride is moving along the expected line", () => {
    const trail: RoutePoint[] = [
      { point: PICKUP, recorded_at: at(10) },
      { point: { lat: 42.40, lng: -82.99 }, recorded_at: at(5) },
      { point: { lat: 42.38, lng: -83.00 }, recorded_at: at(1) },
    ];
    expect(observeTrail(trail, CORRIDOR, NOW).kind).toBe("none");
  });

  it("notices a wide deviation and reports the distance, not a reason", () => {
    const trail: RoutePoint[] = [
      { point: PICKUP, recorded_at: at(10) },
      { point: { lat: 42.60, lng: -83.50 }, recorded_at: at(1) },
    ];
    const o = observeTrail(trail, CORRIDOR, NOW);
    expect(o.kind).toBe("route_deviation");
    expect(o.miles_off_route).toBeGreaterThan(DEVIATION_THRESHOLD_MILES);
    expect(o.description.toLowerCase()).not.toMatch(/kidnap|danger|wrong|suspicious|abduct/);
  });

  it("notices a long stop and reports the minutes, not a reason", () => {
    const stuck = { lat: 42.40, lng: -82.99 };
    const trail: RoutePoint[] = [
      { point: stuck, recorded_at: at(UNEXPECTED_STOP_MINUTES + 5) },
      { point: { lat: 42.4001, lng: -82.9901 }, recorded_at: at(5) },
      { point: stuck, recorded_at: at(1) },
    ];
    const o = observeTrail(trail, CORRIDOR, NOW);
    expect(o.kind).toBe("unexpected_stop");
    expect(o.stopped_minutes).toBeGreaterThanOrEqual(UNEXPECTED_STOP_MINUTES);
    expect(o.description.toLowerCase()).not.toMatch(/danger|emergency|crash|suspicious/);
  });

  it("does not call a short stop unusual", () => {
    const stuck = { lat: 42.40, lng: -82.99 };
    const trail: RoutePoint[] = [
      { point: stuck, recorded_at: at(4) },
      { point: stuck, recorded_at: at(1) },
    ];
    expect(observeTrail(trail, CORRIDOR, NOW).kind).toBe("none");
  });

  it("stays quiet with no data and with no corridor", () => {
    expect(observeTrail([], CORRIDOR, NOW).kind).toBe("none");
    expect(observeTrail([{ point: PICKUP, recorded_at: at(1) }], [], NOW).kind).toBe("none");
  });

  it("never returns an instruction or a conclusion", () => {
    const trail: RoutePoint[] = [
      { point: PICKUP, recorded_at: at(10) },
      { point: { lat: 42.60, lng: -83.50 }, recorded_at: at(1) },
    ];
    const o = observeTrail(trail, CORRIDOR, NOW);
    expect(o.description.toLowerCase()).not.toMatch(/call 911|cancel|pull over|contact police/);
  });
});
