/**
 * Notification delivery decisions. Pure module.
 *
 * Deduplication, retry, and backoff are decided here so they can be tested
 * without a provider. The provider adapters below fail loudly when unconfigured
 * rather than reporting a delivery that never happened.
 */
import { channelAllowed, type TemplateKey } from "./notifications.ts";

export type Channel = "email" | "sms" | "in_app";

export interface QueuedNotification {
  id: string;
  channel: Channel;
  template_key: string;
  idempotency_key: string;
  recipient_email?: string;
  recipient_phone?: string;
  subject?: string;
  body?: string;
  status: string;
  attempt_count?: number;
  queued_at?: string;
  sent_at?: string;
  last_error_code?: string;
}

export type DeliveryAction =
  | { action: "send" }
  | { action: "skip"; code: string; message: string }
  | { action: "defer"; code: string; retryAfterMs: number };

export const MAX_ATTEMPTS = 5;
/** Exponential backoff in minutes, indexed by attempt number. */
export const BACKOFF_MINUTES = [0, 1, 5, 20, 60];

export interface DeliveryContext {
  now: Date;
  /** Idempotency keys already delivered. */
  alreadySent: Set<string>;
  /** Whether a live provider exists for this channel. */
  providerLive: Record<Channel, boolean>;
  /** Deliveries to this recipient in the current window, for rate limiting. */
  recentToRecipient: number;
  perRecipientLimit: number;
}

/**
 * Decide what to do with one queued notification. In-app messages always
 * "send": they are already stored, and delivery is the storage.
 */
export function planDelivery(n: QueuedNotification, ctx: DeliveryContext): DeliveryAction {
  if (n.status === "sent" || n.status === "read") {
    return { action: "skip", code: "already_sent", message: "Already delivered." };
  }
  if (ctx.alreadySent.has(n.idempotency_key)) {
    return { action: "skip", code: "duplicate", message: "An identical notification was already delivered." };
  }
  if (!channelAllowed(n.template_key as TemplateKey, n.channel)) {
    return {
      action: "skip",
      code: "channel_not_permitted",
      message: "This message is not allowed on that channel.",
    };
  }
  if (n.channel === "in_app") return { action: "send" };

  if (!ctx.providerLive[n.channel]) {
    return {
      action: "skip",
      code: "suppressed_provider_missing",
      message: "No provider is configured for this channel, so nothing was sent.",
    };
  }
  if (n.channel === "email" && !n.recipient_email) {
    return { action: "skip", code: "no_address", message: "No email address on file." };
  }
  if (n.channel === "sms" && !n.recipient_phone) {
    return { action: "skip", code: "no_address", message: "No phone number on file." };
  }
  if (ctx.recentToRecipient >= ctx.perRecipientLimit) {
    return { action: "skip", code: "suppressed_rate_limit", message: "Too many messages to this person right now." };
  }

  const attempts = n.attempt_count ?? 0;
  if (attempts >= MAX_ATTEMPTS) {
    return { action: "skip", code: "max_attempts", message: "Gave up after repeated failures." };
  }
  if (attempts > 0) {
    const waitMs = (BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]) * 60_000;
    const last = n.queued_at ? new Date(n.queued_at).getTime() : 0;
    const elapsed = ctx.now.getTime() - last;
    if (elapsed < waitMs) {
      return { action: "defer", code: "backoff", retryAfterMs: waitMs - elapsed };
    }
  }
  return { action: "send" };
}

export interface NotificationProvider {
  readonly name: string;
  readonly channel: Channel;
  readonly isLive: boolean;
  send(n: QueuedNotification): Promise<{ ok: boolean; providerId?: string; errorCode?: string }>;
}

/** Records the attempt and reports failure. It never claims a delivery. */
export function createUnconfiguredProvider(channel: Channel): NotificationProvider {
  return {
    name: "unconfigured",
    channel,
    isLive: false,
    async send() {
      return { ok: false, errorCode: "provider_not_configured" };
    },
  };
}
