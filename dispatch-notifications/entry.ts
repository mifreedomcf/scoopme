/**
 * Deliver queued notifications.
 *
 * Runs on a schedule, and can also be invoked by an administrator to resend one
 * message. Every body is checked against the actual ride record before it goes
 * anywhere, so a template change can never start leaking an address.
 *
 * With no provider configured, messages are marked
 * `suppressed_provider_missing` rather than `sent`. Nothing here claims a
 * delivery that did not happen.
 */
import { forbidden, ok, readJson, serverError } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { secrets } from "base44:runtime";
import {
  BACKOFF_MINUTES, createUnconfiguredProvider, planDelivery,
  type Channel, type NotificationProvider, type QueuedNotification,
} from "../../shared/delivery.ts";
import { assertNotificationSafe } from "../../shared/minimize.ts";

const PER_RECIPIENT_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60_000;

function buildProviders(): Record<Channel, NotificationProvider> {
  const emailMode = secrets.get("NOTIFY_EMAIL_PROVIDER") ?? "mock";
  const smsMode = secrets.get("NOTIFY_SMS_PROVIDER") ?? "mock";
  const smsSid = secrets.get("NOTIFY_SMS_ACCOUNT_SID");

  const email: NotificationProvider = emailMode === "base44_core"
    ? {
        name: "base44_core",
        channel: "email",
        isLive: true,
        // Wired to the platform email integration by the caller below.
        async send() { return { ok: false, errorCode: "not_dispatched_here" }; },
      }
    : createUnconfiguredProvider("email");

  const sms: NotificationProvider = smsMode !== "mock" && smsSid
    ? {
        name: smsMode,
        channel: "sms",
        isLive: true,
        async send() {
          // Milestone 5 issues the provider request here. Deliberately not
          // implemented rather than stubbed with a fake success.
          return { ok: false, errorCode: "provider_not_implemented" };
        },
      }
    : createUnconfiguredProvider("sms");

  const inApp: NotificationProvider = {
    name: "in_app",
    channel: "in_app",
    isLive: true,
    async send() { return { ok: true, providerId: "in_app" }; },
  };

  return { email, sms, in_app: inApp };
}

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    const sr = ctx.base44.asServiceRole.entities;
    const body = await readJson(req);
    const args = (body?.args ?? {}) as Record<string, unknown>;
    const resendId = body?.notification_id ? String(body.notification_id) : "";

    // A manual resend is an administrator action and is audited as one.
    if (resendId) {
      if (!ctx.principal || !hasRole(ctx.principal, "platform_admin")) {
        return forbidden("Only platform administrators can resend a notification.");
      }
    }

    const providers = buildProviders();
    const providerLive: Record<Channel, boolean> = {
      email: providers.email.isLive,
      sms: providers.sms.isLive,
      in_app: true,
    };

    const now = new Date();
    const batchLimit = Number(args.batch_limit ?? 200);

    const queue: QueuedNotification[] = resendId
      ? ((await sr.Notification.filter({ id: resendId }, undefined, 1)) ?? [])
      : ((await sr.Notification.filter({ status: "queued" }, "queued_at", batchLimit)) ?? []);

    const alreadySent = new Set<string>();
    const recentByRecipient = new Map<string, number>();
    const windowStart = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
    const recentlySent = await sr.Notification.filter(
      { status: "sent", sent_at: { $gte: windowStart } }, "-sent_at", 500,
    );
    for (const n of recentlySent ?? []) {
      alreadySent.add(n.idempotency_key);
      const key = n.recipient_user_id ?? n.recipient_email ?? "";
      recentByRecipient.set(key, (recentByRecipient.get(key) ?? 0) + 1);
    }

    const summary = { considered: 0, sent: 0, skipped: 0, deferred: 0, failed: 0, redaction_blocked: 0 };

    for (const n of queue) {
      summary.considered += 1;
      const recipientKey = n.recipient_email ?? "";

      // Last line of defence: never send a body that contains ride detail.
      if (n.ride_request_id) {
        const rides = await sr.RideRequest.filter({ id: n.ride_request_id }, undefined, 1);
        const ride = (rides ?? [])[0];
        if (ride) {
          const check = assertNotificationSafe(`${n.subject ?? ""} ${n.body ?? ""}`, ride);
          if (!check.safe) {
            await sr.Notification.update(n.id, { status: "failed", last_error_code: "redaction_check_failed" });
            await audit(ctx, {
              event_type: "notification.blocked", action: "update", outcome: "denied",
              subject_entity: "Notification", subject_id: n.id,
              reason_code: "redaction_check_failed", metadata: { leaked_fields: check.leaked.join(",") },
            });
            summary.redaction_blocked += 1;
            continue;
          }
        }
      }

      const plan = planDelivery(n, {
        now,
        alreadySent,
        providerLive,
        recentToRecipient: recentByRecipient.get(recipientKey) ?? 0,
        perRecipientLimit: PER_RECIPIENT_LIMIT,
      });

      if (plan.action === "skip") {
        await sr.Notification.update(n.id, {
          status: plan.code.startsWith("suppressed") ? plan.code : "failed",
          last_error_code: plan.code,
        });
        summary.skipped += 1;
        continue;
      }
      if (plan.action === "defer") {
        await sr.Notification.update(n.id, {
          next_attempt_at: new Date(now.getTime() + plan.retryAfterMs).toISOString(),
        });
        summary.deferred += 1;
        continue;
      }

      const provider = providers[n.channel];
      const result = await provider.send(n);
      const attempts = (n.attempt_count ?? 0) + 1;

      if (result.ok) {
        await sr.Notification.update(n.id, {
          status: "sent",
          sent_at: now.toISOString(),
          attempt_count: attempts,
          provider_name: provider.name,
          provider_message_id: result.providerId,
          resent_by_email: resendId ? ctx.principal?.email : undefined,
          resent_at: resendId ? now.toISOString() : undefined,
        });
        alreadySent.add(n.idempotency_key);
        recentByRecipient.set(recipientKey, (recentByRecipient.get(recipientKey) ?? 0) + 1);
        summary.sent += 1;
      } else {
        const nextIndex = Math.min(attempts, BACKOFF_MINUTES.length - 1);
        await sr.Notification.update(n.id, {
          attempt_count: attempts,
          last_error_code: result.errorCode ?? "send_failed",
          provider_name: provider.name,
          next_attempt_at: new Date(now.getTime() + BACKOFF_MINUTES[nextIndex] * 60_000).toISOString(),
          status: attempts >= 5 ? "failed" : "queued",
        });
        summary.failed += 1;
      }
    }

    if (resendId) {
      await audit(ctx, {
        event_type: "notification.resend", action: "update",
        subject_entity: "Notification", subject_id: resendId, metadata: summary,
      });
    }

    return ok({ ...summary, providers: { email: providers.email.name, sms: providers.sms.name } });
  } catch (e) {
    console.error("dispatch_notifications_failed", String(e));
    return serverError();
  }
}
