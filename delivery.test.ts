import { describe, expect, it } from "vitest";
import { BACKOFF_MINUTES, MAX_ATTEMPTS, planDelivery, type DeliveryContext, type QueuedNotification } from "@shared/delivery";

const NOW = new Date("2026-09-09T12:00:00Z");

function ctx(overrides: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    now: NOW,
    alreadySent: new Set<string>(),
    providerLive: { email: true, sms: true, in_app: true },
    recentToRecipient: 0,
    perRecipientLimit: 10,
    ...overrides,
  };
}

function note(overrides: Partial<QueuedNotification> = {}): QueuedNotification {
  return {
    id: "n1",
    channel: "email",
    template_key: "request_approved",
    idempotency_key: "request_approved|ride1|user1",
    recipient_email: "rider@example.invalid",
    status: "queued",
    queued_at: "2026-09-09T11:00:00Z",
    ...overrides,
  };
}

describe("notification delivery planning", () => {
  it("sends a fresh queued message", () => {
    expect(planDelivery(note(), ctx()).action).toBe("send");
  });

  it("never sends the same idempotency key twice", () => {
    const n = note();
    const plan = planDelivery(n, ctx({ alreadySent: new Set([n.idempotency_key]) }));
    expect(plan).toMatchObject({ action: "skip", code: "duplicate" });
    expect(planDelivery(note({ status: "sent" }), ctx())).toMatchObject({ action: "skip", code: "already_sent" });
  });

  it("refuses a template on a channel it is not allowed on", () => {
    expect(planDelivery(note({ template_key: "consent_needed", channel: "sms", recipient_phone: "555-0100" }), ctx()))
      .toMatchObject({ action: "skip", code: "channel_not_permitted" });
    expect(planDelivery(note({ template_key: "incident_update", channel: "sms", recipient_phone: "555-0100" }), ctx()))
      .toMatchObject({ action: "skip", code: "channel_not_permitted" });
  });

  it("suppresses rather than pretends when no provider is configured", () => {
    const plan = planDelivery(note(), ctx({ providerLive: { email: false, sms: false, in_app: true } }));
    expect(plan).toMatchObject({ action: "skip", code: "suppressed_provider_missing" });
  });

  it("always delivers in-app messages, provider or not", () => {
    expect(planDelivery(note({ channel: "in_app" }), ctx({ providerLive: { email: false, sms: false, in_app: true } })).action)
      .toBe("send");
  });

  it("skips a recipient with no address for the channel", () => {
    expect(planDelivery(note({ recipient_email: undefined }), ctx())).toMatchObject({ action: "skip", code: "no_address" });
    expect(planDelivery(note({ channel: "sms", template_key: "driver_arrived", recipient_phone: undefined }), ctx()))
      .toMatchObject({ action: "skip", code: "no_address" });
  });

  it("rate limits a single recipient", () => {
    expect(planDelivery(note(), ctx({ recentToRecipient: 10, perRecipientLimit: 10 })))
      .toMatchObject({ action: "skip", code: "suppressed_rate_limit" });
  });

  it("backs off between retries and gives up eventually", () => {
    const retrying = note({ attempt_count: 2, queued_at: "2026-09-09T11:59:00Z" });
    const deferred = planDelivery(retrying, ctx());
    expect(deferred.action).toBe("defer");
    if (deferred.action === "defer") {
      expect(deferred.retryAfterMs).toBeGreaterThan(0);
      expect(deferred.retryAfterMs).toBeLessThanOrEqual(BACKOFF_MINUTES[2] * 60_000);
    }

    const waitedLongEnough = note({ attempt_count: 2, queued_at: "2026-09-09T11:00:00Z" });
    expect(planDelivery(waitedLongEnough, ctx()).action).toBe("send");

    expect(planDelivery(note({ attempt_count: MAX_ATTEMPTS }), ctx()))
      .toMatchObject({ action: "skip", code: "max_attempts" });
  });
});
