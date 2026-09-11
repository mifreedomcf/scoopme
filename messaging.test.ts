import { describe, expect, it } from "vitest";
import {
  canReadThread, evaluatePost, maskContactDetails, readRequiresAudit,
  threadMembershipAllowed, type ThreadSnapshot,
} from "@shared/messaging";

function thread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    id: "t1",
    kind: "minor_ride",
    ride_request_id: "ride-1",
    dependent_profile_id: "child-1",
    participants: [
      { user_id: "g1", role: "guardian", active: true },
      { user_id: "d1", role: "driver", active: true },
      { user_id: "s1", role: "dispatcher", active: true },
    ],
    locked: false,
    ...overrides,
  };
}

describe("who can be in a conversation", () => {
  it("never puts a driver and a child together", () => {
    const bad = thread({
      participants: [
        { user_id: "g1", role: "guardian", active: true },
        { user_id: "d1", role: "driver", active: true },
        { user_id: "m1", role: "minor", active: true },
      ],
    });
    const r = threadMembershipAllowed(bad);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("forbidden_participant_pair");
  });

  it("requires a guardian in any conversation about a child", () => {
    const noGuardian = thread({
      participants: [
        { user_id: "d1", role: "driver", active: true },
        { user_id: "s1", role: "dispatcher", active: true },
      ],
    });
    expect(threadMembershipAllowed(noGuardian).code).toBe("guardian_required");
  });

  it("treats a removed guardian as absent, so a thread cannot go unsafe later", () => {
    const removed = thread({
      participants: [
        { user_id: "g1", role: "guardian", active: false },
        { user_id: "d1", role: "driver", active: true },
      ],
    });
    expect(threadMembershipAllowed(removed).ok).toBe(false);
  });

  it("keeps children out of these conversations entirely", () => {
    const withMinor = thread({
      participants: [
        { user_id: "g1", role: "guardian", active: true },
        { user_id: "m1", role: "minor", active: true },
      ],
    });
    expect(threadMembershipAllowed(withMinor).code).toBe("minor_not_a_participant");
  });

  it("allows an ordinary adult ride thread", () => {
    const adult = thread({
      kind: "adult_ride",
      dependent_profile_id: undefined,
      participants: [
        { user_id: "r1", role: "rider", active: true },
        { user_id: "d1", role: "driver", active: true },
      ],
    });
    expect(threadMembershipAllowed(adult).ok).toBe(true);
  });
});

describe("posting", () => {
  it("lets a guardian post to their child's thread", () => {
    expect(evaluatePost({ thread: thread(), senderUserId: "g1", body: "We will be at the front door." }).ok).toBe(true);
  });

  it("re-checks membership on every post, not only at creation", () => {
    const gone = thread({
      participants: [
        { user_id: "g1", role: "guardian", active: false },
        { user_id: "d1", role: "driver", active: true },
      ],
    });
    expect(evaluatePost({ thread: gone, senderUserId: "d1", body: "On my way" }).ok).toBe(false);
  });

  it("refuses a non-participant and a removed participant", () => {
    expect(evaluatePost({ thread: thread(), senderUserId: "stranger", body: "hello" }).code).toBe("not_a_participant");
    const removed = thread({
      participants: [
        { user_id: "g1", role: "guardian", active: true },
        { user_id: "d1", role: "driver", active: false },
      ],
    });
    expect(evaluatePost({ thread: removed, senderUserId: "d1", body: "hello" }).code).toBe("not_a_participant");
  });

  it("refuses a locked thread and an empty or oversized message", () => {
    expect(evaluatePost({ thread: thread({ locked: true, lock_reason: "Closed." }), senderUserId: "g1", body: "hi" }).code)
      .toBe("thread_locked");
    expect(evaluatePost({ thread: thread(), senderUserId: "g1", body: "   " }).code).toBe("empty_message");
    expect(evaluatePost({ thread: thread(), senderUserId: "g1", body: "x".repeat(2001) }).code).toBe("message_too_long");
  });

  it("blocks off-platform contact outright on a child's thread", () => {
    const attempts = [
      "Call me on 313-555-0199",
      "Email me at dana@example.invalid",
      "Add me on WhatsApp",
      "Just text me directly, easier",
    ];
    for (const body of attempts) {
      const r = evaluatePost({ thread: thread(), senderUserId: "d1", body });
      expect(r.ok, body).toBe(false);
      expect(r.code).toBe("off_platform_contact_blocked");
      expect(r.flagged).toBe(true);
    }
  });

  it("allows but flags the same thing on an adult thread", () => {
    const adult = thread({
      kind: "adult_ride",
      dependent_profile_id: undefined,
      participants: [
        { user_id: "r1", role: "rider", active: true },
        { user_id: "d1", role: "driver", active: true },
      ],
    });
    const r = evaluatePost({ thread: adult, senderUserId: "r1", body: "Call me on 313-555-0199" });
    expect(r.ok).toBe(true);
    expect(r.flagged).toBe(true);
  });
});

describe("storage and reading", () => {
  it("masks phone numbers and email addresses before anything is stored", () => {
    const masked = maskContactDetails("Reach me on 313-555-0199 or dana@example.invalid");
    expect(masked).toContain("[number removed]");
    expect(masked).toContain("[address removed]");
    expect(masked).not.toContain("313-555-0199");
    expect(masked).not.toContain("dana@example.invalid");
  });

  it("lets participants and staff read, and nobody else", () => {
    expect(canReadThread(thread(), "g1", false)).toBe(true);
    expect(canReadThread(thread(), "stranger", false)).toBe(false);
    expect(canReadThread(thread(), "stranger", true)).toBe(true);
  });

  it("never lets a child read, even if somehow listed", () => {
    const withMinor = thread({
      participants: [
        { user_id: "g1", role: "guardian", active: true },
        { user_id: "m1", role: "minor", active: true },
      ],
    });
    expect(canReadThread(withMinor, "m1", false)).toBe(false);
  });

  it("audits every read of a child's thread", () => {
    expect(readRequiresAudit(thread())).toBe(true);
    expect(readRequiresAudit(thread({ kind: "adult_ride" }))).toBe(false);
  });
});
