/**
 * In-platform messaging. Pure module.
 *
 * The single rule that shapes this file: there is no channel, anywhere, in
 * which a driver and a child can talk to each other privately. Messages about a
 * minor's ride route through the guardian and the platform, contacts are
 * masked, and every read is logged.
 */

export type ThreadKind = "adult_ride" | "minor_ride" | "support" | "organization";
export type ParticipantRole = "rider" | "guardian" | "driver" | "dispatcher" | "safety_staff" | "org_scheduler" | "minor";

export interface ThreadParticipant {
  user_id: string;
  role: ParticipantRole;
  /** Removed participants keep history but cannot post or read new messages. */
  active: boolean;
}

export interface ThreadSnapshot {
  id: string;
  kind: ThreadKind;
  ride_request_id?: string;
  dependent_profile_id?: string;
  participants: ThreadParticipant[];
  locked: boolean;
  lock_reason?: string;
}

export interface PostCheck {
  ok: boolean;
  code: string;
  message: string;
}

/** Roles that may never be in the same thread without staff present. */
const FORBIDDEN_PAIRS: [ParticipantRole, ParticipantRole][] = [
  ["driver", "minor"],
];

/**
 * Is this thread's membership itself permissible?
 *
 * Called when a thread is created AND before every post, so a thread cannot
 * become unsafe by having someone added to it later.
 */
export function threadMembershipAllowed(thread: ThreadSnapshot): PostCheck {
  const activeRoles = thread.participants.filter((p) => p.active).map((p) => p.role);

  for (const [a, b] of FORBIDDEN_PAIRS) {
    if (activeRoles.includes(a) && activeRoles.includes(b)) {
      return {
        ok: false,
        code: "forbidden_participant_pair",
        message: "A driver and a child cannot be in the same conversation. Messages go through the guardian.",
      };
    }
  }

  if (thread.kind === "minor_ride") {
    // A minor's thread must contain a guardian. Without one it is not a
    // supervised channel, whoever else is in it.
    if (!activeRoles.includes("guardian")) {
      return {
        ok: false,
        code: "guardian_required",
        message: "A conversation about a child's ride has to include their verified guardian.",
      };
    }
    if (activeRoles.includes("minor")) {
      return {
        ok: false,
        code: "minor_not_a_participant",
        message: "Children are not participants in these conversations. Their guardian is.",
      };
    }
  }

  return { ok: true, code: "membership_ok", message: "Membership permitted." };
}

export interface PostAttempt {
  thread: ThreadSnapshot;
  senderUserId: string;
  body: string;
}

/** Patterns that look like an attempt to move the conversation off-platform. */
const OFF_PLATFORM = [
  /\b\d{3}[.\-\s]?\d{3}[.\-\s]?\d{4}\b/,               // phone number
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/,                     // email address
  /\b(?:whatsapp|telegram|signal|snapchat|instagram|facebook|messenger|tiktok)\b/i,
  /\btext me\b|\bcall me directly\b|\bmy cell\b|\bmy number\b/i,
];

export interface PostVerdict extends PostCheck {
  /** Content stripped or flagged before storage. */
  redactions: string[];
  /** Staff should look at this. Not a block on its own for an adult thread. */
  flagged: boolean;
}

/**
 * Decide whether a message may be posted, and what has to be stripped first.
 */
export function evaluatePost(attempt: PostAttempt): PostVerdict {
  const { thread, senderUserId, body } = attempt;
  const deny = (code: string, message: string): PostVerdict =>
    ({ ok: false, code, message, redactions: [], flagged: false });

  const membership = threadMembershipAllowed(thread);
  if (!membership.ok) return deny(membership.code, membership.message);

  if (thread.locked) {
    return deny("thread_locked", thread.lock_reason ?? "This conversation is closed.");
  }

  const sender = thread.participants.find((p) => p.user_id === senderUserId);
  if (!sender || !sender.active) {
    return deny("not_a_participant", "You are not part of this conversation.");
  }
  if (sender.role === "minor") {
    return deny("minor_cannot_post", "Children do not post here. Their guardian does.");
  }

  const text = (body ?? "").trim();
  if (text.length === 0) return deny("empty_message", "Write something first.");
  if (text.length > 2000) return deny("message_too_long", "Keep it under 2000 characters.");

  const redactions: string[] = [];
  for (const pattern of OFF_PLATFORM) {
    if (pattern.test(text)) redactions.push(pattern.source);
  }

  // On a minor's thread, an attempt to share direct contact details is refused
  // outright rather than redacted, and staff are told.
  if (thread.kind === "minor_ride" && redactions.length > 0) {
    return {
      ok: false,
      code: "off_platform_contact_blocked",
      message:
        "Phone numbers, email addresses and other apps cannot be shared in a conversation about a child. Everything stays here, where a coordinator can see it.",
      redactions,
      flagged: true,
    };
  }

  return {
    ok: true,
    code: "post_allowed",
    message: "Allowed.",
    redactions,
    flagged: redactions.length > 0,
  };
}

/** Replace anything that looks like direct contact details before storage. */
export function maskContactDetails(body: string): string {
  let out = body;
  out = out.replace(/\b\d{3}[.\-\s]?\d{3}[.\-\s]?\d{4}\b/g, "[number removed]");
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[address removed]");
  return out;
}

/** Who may read this thread. A driver reads only their own assigned ride's thread. */
export function canReadThread(thread: ThreadSnapshot, userId: string, isStaff: boolean): boolean {
  if (isStaff) return true;
  const participant = thread.participants.find((p) => p.user_id === userId);
  return Boolean(participant && participant.active && participant.role !== "minor");
}

/** Every read of a minor's thread is an audited event. */
export function readRequiresAudit(thread: ThreadSnapshot): boolean {
  return thread.kind === "minor_ride";
}
