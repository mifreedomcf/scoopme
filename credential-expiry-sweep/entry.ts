/**
 * Daily sweep: expire lapsed credentials, recompute every driver's eligibility,
 * and warn about documents about to run out.
 *
 * Suspension here is arithmetic, not judgement. A document past its date makes
 * a driver ineligible the same morning, whether or not anyone noticed.
 */
import { ok, serverError } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import { computeEligibility, EXPIRY_NOTICE_DAYS } from "../../shared/eligibility.ts";
import { idempotencyKey } from "../../shared/ids.ts";
import { renderTemplate } from "../../shared/notifications.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    const sr = ctx.base44.asServiceRole.entities;
    const today = todayISO();
    const now = new Date().toISOString();
    const config = await loadConfig(ctx);

    const summary = { drivers_checked: 0, credentials_expired: 0, suspended: 0, restored: 0, notices_queued: 0 };

    // 1. Mark verified credentials whose date has passed.
    const lapsed = await sr.DriverCredential.filter(
      { status: "verified", expiration_date: { $lt: today } }, "expiration_date", 500,
    );
    for (const credential of lapsed ?? []) {
      await sr.DriverCredential.update(credential.id, { status: "expired" });
      summary.credentials_expired += 1;
    }

    // 2. Recompute eligibility for every driver, every day.
    const drivers = await sr.DriverProfile.list("-created_date", 1000);
    for (const driver of drivers ?? []) {
      summary.drivers_checked += 1;
      const [credentials, vehicles] = await Promise.all([
        sr.DriverCredential.filter({ driver_profile_id: driver.id }),
        sr.Vehicle.filter({ driver_profile_id: driver.id }),
      ]);
      const result = computeEligibility({
        approval_tier: driver.approval_tier,
        admin_suspended: driver.admin_suspended,
        on_incident_hold: driver.on_incident_hold,
        credentials: credentials ?? [],
        vehicles: vehicles ?? [],
        today,
      });

      if (result.status !== driver.eligibility_status || result.reason_code !== driver.eligibility_reason_code) {
        await sr.DriverProfile.update(driver.id, {
          eligibility_status: result.status,
          eligibility_reason_code: result.reason_code,
          eligibility_blocking: result.blocking,
          eligibility_computed_at: now,
        });
        if (driver.eligibility_status === "eligible" && result.status !== "eligible") {
          summary.suspended += 1;
          // Pull this driver's open offers: they are no longer eligible for them.
          await sr.RideOffer.updateMany(
            { driver_profile_id: driver.id, status: "open" },
            { $set: { status: "withdrawn", responded_at: now } },
          );
          await audit(ctx, {
            event_type: "driver.eligibility_suspended", action: "update",
            subject_entity: "DriverProfile", subject_id: driver.id,
            from_state: driver.eligibility_status, to_state: result.status,
            reason_code: result.reason_code, metadata: { blocking: result.blocking.join(",") },
          });
        }
        if (driver.eligibility_status !== "eligible" && result.status === "eligible") {
          summary.restored += 1;
        }
      }

      // 3. Advance notice, once per credential per expiry date.
      for (const soon of result.expiring_soon) {
        const key = idempotencyKey(["credential_expiring", driver.id, soon.credential_type, soon.expiration_date]);
        const already = await sr.Notification.filter({ idempotency_key: key }, undefined, 1);
        if ((already ?? []).length > 0) continue;

        const rendered = renderTemplate("credential_expiring", {
          brandName: String(config.brand_name),
          genericDestinationLabel: "",
          credentialLabel: soon.credential_type.replace(/_/g, " "),
          expiresOn: soon.expiration_date,
        });
        await sr.Notification.create({
          recipient_user_id: driver.user_id,
          channel: "in_app",
          template_key: "credential_expiring",
          subject: rendered.subject,
          body: rendered.body,
          idempotency_key: key,
          status: "queued",
          queued_at: now,
        });
        summary.notices_queued += 1;
      }
    }

    await audit(ctx, {
      event_type: "sweep.credential_expiry", action: "update",
      metadata: { ...summary, notice_window_days: EXPIRY_NOTICE_DAYS },
    });

    return ok({ swept_on: today, ...summary });
  } catch (e) {
    console.error("credential_expiry_sweep_failed", String(e));
    return serverError();
  }
}
