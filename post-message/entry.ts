/**
 * Post to a supervised thread.
 *
 * There is no code path anywhere in this application that puts a driver and a
 * child in a private conversation. `threadMembershipAllowed` is re-checked on
 * every post, so a thread cannot become unsafe by someone being added to it
 * after it was created.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { isStaff } from "../../shared/authz.ts";
import {
  canReadThread, evaluatePost, maskContactDetails, readRequiresAudit,
  type ThreadParticipant, type ThreadSnapshot,
} from "../../shared/messaging.ts";

function toSnapshot(row: Record<string, unknown>): ThreadSnapshot {
  const ids = (row.participant_user_ids ?? []) as string[];
  const roles = (row.participant_roles ?? []) as string[];
  const inactive = new Set((row.inactive_participant_user_ids ?? []) as string[]);
  const participants: ThreadParticipant[] = ids.map((user_id, i) => ({
    user_id,
    role: (roles[i] ?? "rider") as ThreadParticipant["role"],
    active: !inactive.has(user_id),
  }));
  return {
    id: String(row.id),
    kind: String(row.kind) as ThreadSnapshot["kind"],
    ride_request_id: row.ride_request_id as string | undefined,
    dependent_profile_id: row.dependent_profile_id as string | undefined,
    participants,
    locked: row.locked === true,
    lock_reason: row.lock_reason as string | undefined,
  };
}

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const threadId = String(body.thread_id ?? "");
    const action = String(body.action ?? "post");

    const sr = ctx.base44.asServiceRole.entities;
    const rows = await sr.MessageThread.filter({ id: threadId }, undefined, 1);
    const row = (rows ?? [])[0];
    if (!row) return notFound("That conversation does not exist.");
    const thread = toSnapshot(row);

    const staff = isStaff(ctx.principal);
    if (!canReadThread(thread, ctx.principal.userId, staff)) {
      return notFound("That conversation does not exist.");
    }

    if (action === "read") {
      const messages = await sr.Message.filter({ thread_id: threadId }, "sent_at", 200);
      if (readRequiresAudit(thread)) {
        await audit(ctx, {
          event_type: "access.minor_record", action: "read",
          subject_entity: "MessageThread", subject_id: threadId,
          reason_code: "minor_thread_read",
        });
      }
      return ok({
        thread_id: threadId,
        kind: thread.kind,
        messages: (messages ?? []).map((m: Record<string, unknown>) => ({
          id: m.id, sender_role: m.sender_role, body: m.body, sent_at: m.sent_at,
        })),
        notice: thread.kind === "minor_ride"
          ? "Everything here is visible to a coordinator, and every time it is opened is recorded."
          : undefined,
      });
    }

    const verdict = evaluatePost({
      thread,
      senderUserId: ctx.principal.userId,
      body: String(body.body ?? ""),
    });

    if (!verdict.ok) {
      await audit(ctx, {
        event_type: "message.blocked", action: "create", outcome: "denied",
        subject_entity: "MessageThread", subject_id: threadId,
        reason_code: verdict.code,
        metadata: { kind: thread.kind, flagged: verdict.flagged },
      });
      return fail(verdict.code, verdict.message, 403);
    }

    const sender = thread.participants.find((p) => p.user_id === ctx.principal!.userId);
    const now = new Date().toISOString();
    const stored = maskContactDetails(String(body.body));

    const created = await sr.Message.create({
      thread_id: threadId,
      sender_user_id: ctx.principal.userId,
      sender_role: sender?.role ?? "rider",
      body: stored,
      original_flagged: verdict.flagged,
      redaction_codes: verdict.redactions.length > 0 ? ["contact_details_masked"] : [],
      sent_at: now,
    });
    await sr.MessageThread.update(threadId, { last_message_at: now });

    await audit(ctx, {
      event_type: "message.posted", action: "create",
      subject_entity: "Message", subject_id: created.id,
      metadata: { thread_kind: thread.kind, flagged: verdict.flagged, masked: verdict.redactions.length > 0 },
    });

    return ok({
      message_id: created.id,
      masked: verdict.redactions.length > 0,
      flagged: verdict.flagged,
      notice: verdict.redactions.length > 0
        ? "Phone numbers and email addresses are removed automatically. Keep everything in here so a coordinator can see it."
        : undefined,
    }, 201);
  } catch (e) {
    console.error("post_message_failed", String(e));
    return serverError();
  }
}
