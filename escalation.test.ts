import { describe, expect, it } from "vitest";
import { escalationAudience, evaluateRideWatch, THRESHOLDS } from "@shared/escalation";

const PICKUP = "2026-09-11T10:00:00Z";
const at = (minutesAfterPickup: number) => new Date(new Date(PICKUP).getTime() + minutesAfterPickup * 60_000);

describe("ride check-in timers", () => {
  it("says nothing while a ride is inside its grace period", () => {
    expect(evaluateRideWatch({ status: "confirmed", requested_pickup_at: PICKUP, now: at(5) }).raise).toBe(false);
    expect(evaluateRideWatch({ status: "en_route", requested_pickup_at: PICKUP, now: at(10) }).raise).toBe(false);
  });

  it("raises a notice when a driver has not set off", () => {
    const v = evaluateRideWatch({ status: "confirmed", requested_pickup_at: PICKUP, now: at(THRESHOLDS.departure_grace + 1) });
    expect(v.raise).toBe(true);
    expect(v.kind).toBe("overdue_departure");
    expect(v.level).toBe(1);
  });

  it("escalates to urgent at twice the threshold", () => {
    const v = evaluateRideWatch({
      status: "en_route", requested_pickup_at: PICKUP,
      now: at(THRESHOLDS.pickup_arrival_grace * 2 + 1),
    });
    expect(v.level).toBe(2);
    expect(escalationAudience(v.level)).toEqual(["dispatcher", "safety_staff"]);
    expect(escalationAudience(1)).toEqual(["dispatcher"]);
  });

  it("does not raise the same alert twice at the same level", () => {
    const late = at(THRESHOLDS.departure_grace + 1);
    const first = evaluateRideWatch({ status: "confirmed", requested_pickup_at: PICKUP, now: late });
    expect(first.raise).toBe(true);
    const second = evaluateRideWatch({
      status: "confirmed", requested_pickup_at: PICKUP, now: late, escalation_level: first.level,
    });
    expect(second.raise).toBe(false);
  });

  it("still escalates from notice to urgent once it gets worse", () => {
    const v = evaluateRideWatch({
      status: "confirmed", requested_pickup_at: PICKUP,
      now: at(THRESHOLDS.departure_grace * 2 + 1), escalation_level: 1,
    });
    expect(v.raise).toBe(true);
    expect(v.level).toBe(2);
  });

  it("watches for silence during a trip and for an unconfirmed drop-off", () => {
    const silence = evaluateRideWatch({
      status: "in_progress",
      last_check_in_at: PICKUP,
      now: at(THRESHOLDS.contact_silence + 1),
    });
    expect(silence.kind).toBe("loss_of_contact");

    const handoff = evaluateRideWatch({
      status: "arrived_dropoff",
      last_check_in_at: PICKUP,
      now: at(THRESHOLDS.handoff_grace + 1),
    });
    expect(handoff.kind).toBe("handoff_overdue");
  });

  it("flags a ride running past the time the rider needed to be there", () => {
    const v = evaluateRideWatch({
      status: "in_progress",
      arrival_by_at: PICKUP,
      now: at(THRESHOLDS.dropoff_arrival_grace + 1),
    });
    expect(v.kind).toBe("overdue_arrival_dropoff");
  });

  it("stops watching a ride that is finished or not yet underway", () => {
    for (const status of ["completed", "canceled", "approved", "offered", "claimed", "incident_hold"]) {
      expect(evaluateRideWatch({ status, requested_pickup_at: PICKUP, now: at(600) }).raise).toBe(false);
    }
  });

  it("never returns an instruction, only an observation", () => {
    const v = evaluateRideWatch({ status: "en_route", requested_pickup_at: PICKUP, now: at(120) });
    expect(v.message?.toLowerCase()).not.toMatch(/call 911|cancel|emergency/);
  });
});
