/**
 * A guardian withdraws consent.
 *
 * Withdrawal takes effect immediately and stops any trip that has not started.
 * It is never refused, never delayed, and never requires a reason.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";
import { idempotencyKey } from "../../shared/ids.ts";

/** States a ride can be pulled back from when consent goes away. */
const STOPPABLE = ["awaiting_consent", "approved", "offered", "claimed", "confirmed", "eligibility_review"];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const consentId = String(body.consent_record_id ?? "");

    const sr = ctx.base44.asServiceRole.entities;
    const rows = await sr.ConsentRecord.filter({ id: consentId }, undefined, 1);
    const record = (rows ?? [])[0];
    if (!record) return notFound("That consent does not exist.");

    // Only the person who signed it, or the verified guardian, may withdraw it.
    const relRows = await sr.GuardianRelationship.filter({ id: record.guardian_relationship_id }, undefined, 1);
    const relationship = (relRows ?? [])[0];
    const isSigner = record.signer_user_id === ctx.principal.userId;
    const isGuardian = relationship?.guardian_user_id === ctx.principal.userId;
    if (!isSigner && !isGuardian) {
      await audit(ctx, {
        event_type: "minor.consent_revoked", action: "update", outcome: "denied",
        subject_entity: "ConsentRecord", subject_id: consentId, reason_code: "not_the_guardian",
      });
      return notFound("That consent does not exist.");
    }

    const now = new Date().toISOString();
    const config = await loadConfig(ctx);

    await sr.ConsentRecord.update(consentId, {
      status: "revoked", revoked_at: now, revoked_by_user_id: ctx.principal.userId,
    });

    // Stop everything this consent was holding up.
    const affected: string[] = [];
    const rideIds = record.ride_request_id
      ? [record.ride_request_id]
      : (await sr.RideRequest.filter(
          { dependent_profile_id: record.dependent_profile_id, status: { $in: STOPPABLE } },
          "-created_date", 100,
        ) ?? []).map((r: { id: string }) => r.id);

    for (const rideId of rideIds) {
      const rideRows = await sr.RideRequest.filter({ id: rideId }, undefined, 1);
      const ride = (rideRows ?? [])[0];
      if (!ride || !STOPPABLE.includes(ride.status)) continue;

      await sr.RideRequest.update(rideId, {
        status: "canceled", status_reason_code: "consent_withdrawn", canceled_at: now, verification_code: "",
      });
      await sr.RideOffer.updateMany(
        { ride_request_id: rideId, status: "open" },
        { $set: { status: "withdrawn", responded_at: now } },
      );
      const assignments = await sr.RideAssignment.filter({ ride_request_id: rideId, is_active: true });
      for (const a of assignments ?? []) {
        await sr.RideAssignment.update(a.id, {
          is_active: false, released_at: now, release_reason_code: "consent_withdrawn",
        });
      }
      await sr.RideEvent.create({
        ride_request_id: rideId, event_type: "transition",
        from_state: ride.status, to_state: "canceled",
        actor_user_id: ctx.principal.userId, actor_role: "guardian",
        reason_code: "consent_withdrawn", occurred_at: now,
      });
      affected.push(rideId);
    }

    // Tell dispatch, without saying anything about the child.
    const dispatchers = await sr.RoleAssignment.filter({ role: "dispatcher", status: "approved" });
    for (const d of dispatchers ?? []) {
      await sr.Notification.create({
        recipient_user_id: d.user_id,
        recipient_email: d.user_email,
        channel: "in_app",
        template_key: "incident_update",
        subject: `${config.brand_name}: consent withdrawn`,
        body: `A guardian has withdrawn consent. ${affected.length} scheduled ride(s) were stopped.`,
        idempotency_key: idempotencyKey(["consent_revoked", consentId, d.user_id]),
        status: "queued",
        queued_at: now,
      });
    }

    await audit(ctx, {
      event_type: "minor.consent_revoked", action: "update",
      subject_entity: "ConsentRecord", subject_id: consentId,
      to_state: "revoked", metadata: { rides_stopped: affected.length },
    });

    return ok({
      consent_record_id: consentId,
      status: "revoked",
      rides_stopped: affected.length,
      message: "Withdrawn. Any trip that had not started has been stopped. You do not need to give a reason.",
    });
  } catch (e) {
    console.error("revoke_consent_failed", String(e));
    return serverError();
  }
}
