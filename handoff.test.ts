import { describe, expect, it } from "vitest";
import {
  FAILED_HANDOFF_INSTRUCTIONS, MAX_HANDOFF_ATTEMPTS, issueHandoffPin,
  mayRevealHandoffDetails, verifyHandoff,
  type AuthorizedAdult, type HandoffState,
} from "@shared/handoff";

const NOW = "2026-09-11T10:00:00Z";
const ISSUED = "2026-09-11T08:00:00Z";

const grandmother: AuthorizedAdult = {
  id: "adult-1", dependent_profile_id: "child-1", name: "Rosa T.",
  relationship: "grandmother", phone: "555-0144", role: "both", active: true,
};
const neighbour: AuthorizedAdult = {
  id: "adult-2", dependent_profile_id: "child-1", name: "Dee P.",
  relationship: "neighbour", phone: "555-0155", role: "dropoff", active: true,
};

function state(overrides: Partial<HandoffState> = {}): HandoffState {
  return {
    expected_pin: "K7Q2MP",
    expected_adult_ids: ["adult-1"],
    pin_issued_at: ISSUED,
    failed_attempts: 0,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    dependent_profile_id: "child-1",
    ride_request_id: "ride-1",
    role: "dropoff" as const,
    claimed_adult_id: "adult-1",
    submitted_pin: "K7Q2MP",
    now: NOW,
    ...overrides,
  };
}

describe("issuing a handoff PIN", () => {
  it("never reuses a PIN this child has had before", () => {
    const history: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const pin = issueHandoffPin(history);
      expect(history).not.toContain(pin);
      history.push(pin);
    }
  });

  it("uses an alphabet with no characters that can be misheard", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(issueHandoffPin([])).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    }
  });
});

describe("verifying a handoff", () => {
  it("accepts the named adult with the right code", () => {
    const r = verifyHandoff(attempt(), state(), [grandmother]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toContain("Rosa T.");
  });

  it("refuses someone who is not on the list", () => {
    const r = verifyHandoff(attempt({ claimed_adult_id: "stranger" }), state(), [grandmother]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("adult_not_recorded");
      expect(r.escalate).toBe(true);
      expect(r.message).toContain("Do not hand the child over");
    }
  });

  it("refuses someone the guardian has removed", () => {
    const r = verifyHandoff(attempt(), state(), [{ ...grandmother, active: false }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("adult_no_longer_authorized");
  });

  it("refuses an adult listed for a different child", () => {
    const r = verifyHandoff(attempt(), state(), [{ ...grandmother, dependent_profile_id: "child-2" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("adult_other_child");
  });

  it("refuses an adult listed for the other leg of the trip", () => {
    const r = verifyHandoff(
      attempt({ role: "pickup", claimed_adult_id: "adult-2" }),
      state({ expected_adult_ids: ["adult-2"] }),
      [neighbour],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("adult_wrong_role");
  });

  it("refuses an adult who is on the list but not expected for this trip", () => {
    const r = verifyHandoff(
      attempt({ claimed_adult_id: "adult-2" }),
      state({ expected_adult_ids: ["adult-1"] }),
      [grandmother, neighbour],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("adult_not_expected_for_this_trip");
  });

  it("refuses a wrong code and counts down the tries", () => {
    const r = verifyHandoff(attempt({ submitted_pin: "AAAAAA" }), state(), [grandmother]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("pin_mismatch");
      expect(r.message).toContain("2 tries left");
      expect(r.escalate).toBe(false);
    }
  });

  it("escalates on the last wrong try, and refuses outright after that", () => {
    const last = verifyHandoff(
      attempt({ submitted_pin: "AAAAAA" }),
      state({ failed_attempts: MAX_HANDOFF_ATTEMPTS - 1 }),
      [grandmother],
    );
    expect(last.ok).toBe(false);
    if (!last.ok) {
      expect(last.escalate).toBe(true);
      expect(last.message).toContain("call the safety line");
    }
    const after = verifyHandoff(attempt(), state({ failed_attempts: MAX_HANDOFF_ATTEMPTS }), [grandmother]);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("too_many_attempts");
  });

  it("refuses a code that has already been used", () => {
    const r = verifyHandoff(attempt(), state({ pin_used_at: "2026-09-11T09:00:00Z" }), [grandmother]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("pin_already_used");
  });

  it("refuses a stale code rather than letting an old one through", () => {
    const r = verifyHandoff(attempt(), state({ pin_issued_at: "2026-09-09T08:00:00Z" }), [grandmother]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("pin_stale");
  });

  it("never tells the driver anything about the expected code", () => {
    const r = verifyHandoff(attempt({ submitted_pin: "AAAAAA" }), state(), [grandmother]);
    if (!r.ok) {
      expect(r.message).not.toContain("K7Q2MP");
      expect(r.message).not.toMatch(/starts with|begins|first (letter|character)/i);
    }
  });

  it("never offers an alternative to handing over safely", () => {
    const failures = [
      verifyHandoff(attempt({ claimed_adult_id: "stranger" }), state(), [grandmother]),
      verifyHandoff(attempt({ submitted_pin: "AAAAAA" }), state({ failed_attempts: 2 }), [grandmother]),
      verifyHandoff(attempt(), state({ pin_used_at: NOW }), [grandmother]),
    ];
    for (const r of failures) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message.toLowerCase()).not.toMatch(/instead|another address|drop (them|the child) at|leave (them|the child)|wait outside/);
      }
    }
  });
});

describe("what a driver is told when it fails", () => {
  it("tells them to stop, stay, and call — and never to leave the child", () => {
    const joined = FAILED_HANDOFF_INSTRUCTIONS.join(" ").toLowerCase();
    expect(joined).toContain("stop where you are");
    expect(joined).toContain("stay with the child");
    expect(joined).toContain("call the safety line");
    expect(joined).toContain("911");
    expect(joined).toContain("never leave a child unattended");
    expect(joined).toContain("do not decide a new drop-off yourself");
  });
});

describe("when handoff details are released", () => {
  it("gives them only to the assigned driver, only in an active state, only near the trip", () => {
    expect(mayRevealHandoffDetails(true, "confirmed", 60)).toBe(true);
    expect(mayRevealHandoffDetails(false, "confirmed", 60)).toBe(false);
    expect(mayRevealHandoffDetails(true, "approved", 60)).toBe(false);
    expect(mayRevealHandoffDetails(true, "offered", 10)).toBe(false);
    expect(mayRevealHandoffDetails(true, "confirmed", 600)).toBe(false);
    expect(mayRevealHandoffDetails(true, "completed", 10)).toBe(false);
  });
});
