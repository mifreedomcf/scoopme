import { describe, expect, it } from "vitest";
import { allowedTransitionsFrom, canTransition } from "@shared/state-machine";

describe("ride state machine", () => {
  it("walks the happy path from submission to completion", () => {
    const path: [string, string, Parameters<typeof canTransition>[2]][] = [
      ["draft", "submitted", { actorRole: "rider", isRideParty: true }],
      ["submitted", "eligibility_review", { actorRole: "system" }],
      ["eligibility_review", "approved", { actorRole: "dispatcher" }],
      ["approved", "offered", { actorRole: "dispatcher" }],
      ["offered", "claimed", { actorRole: "driver" }],
      ["claimed", "confirmed", { actorRole: "dispatcher" }],
      ["confirmed", "en_route", { actorRole: "driver", isAssignedDriver: true }],
      ["en_route", "arrived_pickup", { actorRole: "driver", isAssignedDriver: true }],
      ["arrived_pickup", "rider_verified", { actorRole: "driver", isAssignedDriver: true }],
      ["rider_verified", "in_progress", { actorRole: "driver", isAssignedDriver: true }],
      ["in_progress", "arrived_dropoff", { actorRole: "driver", isAssignedDriver: true }],
      ["arrived_dropoff", "handoff_verified", { actorRole: "driver", isAssignedDriver: true }],
      ["handoff_verified", "completed", { actorRole: "driver", isAssignedDriver: true }],
    ];
    for (const [from, to, ctx] of path) {
      const verdict = canTransition(from as never, to as never, ctx);
      expect(verdict.allowed, `${from} -> ${to}: ${verdict.message}`).toBe(true);
    }
  });

  it("refuses a transition that skips the middle of the flow", () => {
    expect(canTransition("submitted", "completed", { actorRole: "dispatcher" }).code).toBe("illegal_transition");
    expect(canTransition("approved", "in_progress", { actorRole: "driver", isAssignedDriver: true }).code).toBe("illegal_transition");
  });

  it("refuses a rider approving their own ride", () => {
    const v = canTransition("eligibility_review", "approved", { actorRole: "rider", isRideParty: true });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("actor_not_permitted");
  });

  it("refuses a driver who is not assigned to this ride", () => {
    const v = canTransition("confirmed", "en_route", { actorRole: "driver", isAssignedDriver: false });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("not_assigned_driver");
  });

  it("refuses a rider acting on someone else's ride", () => {
    const v = canTransition("approved", "canceled", { actorRole: "rider", isRideParty: false, reasonCode: "x" });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("not_ride_party");
  });

  it("requires a reason code where the rule demands one", () => {
    expect(canTransition("approved", "canceled", { actorRole: "dispatcher" }).code).toBe("reason_required");
    expect(canTransition("approved", "canceled", { actorRole: "dispatcher", reasonCode: "rider_request" }).allowed).toBe(true);
  });

  it("treats completed as terminal, except for a safety escalation", () => {
    expect(canTransition("completed", "in_progress", { actorRole: "platform_admin" }).code).toBe("terminal_state");
    expect(
      canTransition("completed", "incident_hold", { actorRole: "safety_staff", reasonCode: "report_received" }).allowed,
    ).toBe(true);
  });

  it("blocks administrative closure while a retention hold is active", () => {
    const v = canTransition("incident_hold", "closed_by_admin", {
      actorRole: "platform_admin", reasonCode: "resolved", retentionHoldActive: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe("retention_hold_active");
  });

  it("routes a failed handoff to the safety team, never onward to completion", () => {
    expect(allowedTransitionsFrom("failed_handoff")).toEqual(["incident_hold"]);
  });
});
