/**
 * A rider, or a child's verified guardian, turns on location sharing for one ride.
 *
 * Nobody else can start it — not staff, not the driver. The grantor picks the
 * audiences, and an organization scheduler is opt-in rather than assumed. A
 * token is minted per audience, expires with the trip, and is never reused.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { checkGatesForFlag } from "../../shared/flags.ts";
import { secureToken } from "../../shared/ids.ts";
import { defaultAudiences, linkExpiry, type TrackingAudience } from "../../shared/tracking.ts";

const VALID_AUDIENCES: TrackingAudience[] = [
  "rider", "guardian", "org_scheduler", "assigned_driver", "safety_staff", "dispatcher",
];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const config = await loadConfig(ctx);
    if (!config.live_location_enabled) {
      return fail(
        "live_location_disabled",
        "Live location is switched off. Your ride works exactly the same without it.",
        409,
      );
    }
    const gates = await loadGates(ctx);
    if (!checkGatesForFlag("live_location_enabled", gates, todayISO()).satisfied) {
      return fail("gate_incomplete", "Live location is blocked by incomplete launch gates.", 409);
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const rideId = String(body.ride_request_id ?? "");

    const sr = ctx.base44.asServiceRole.entities;
    const rides = await sr.RideRequest.filter({ id: rideId }, undefined, 1);
    const ride = (rides ?? [])[0];
    if (!ride) return notFound("That ride does not exist.");

    // Who may grant this: the adult rider, or the verified guardian of the child.
    let mayGrant = ride.rider_user_id === ctx.principal.userId;
    if (!mayGrant && ride.rider_kind === "minor" && ride.dependent_profile_id) {
      const rel = await sr.GuardianRelationship.filter({
        dependent_profile_id: ride.dependent_profile_id,
        guardian_user_id: ctx.principal.userId,
        status: "verified",
      }, undefined, 1);
      mayGrant = (rel ?? []).length > 0;
    }
    if (!mayGrant) {
      await audit(ctx, {
        event_type: "location.consent_denied", action: "create", outcome: "denied",
        subject_entity: "RideRequest", subject_id: rideId, reason_code: "not_the_grantor",
      });
      return forbidden(
        "Only the rider, or a child's verified guardian, can turn location sharing on. Staff and drivers cannot do it for you.",
      );
    }

    const requested = (body.audiences ?? []) as string[];
    const chosen = requested.filter((a): a is TrackingAudience => VALID_AUDIENCES.includes(a as TrackingAudience));
    const audiences = chosen.length > 0
      ? Array.from(new Set([...chosen, "safety_staff", "dispatcher"]))
      : defaultAudiences(String(ride.rider_kind ?? "adult"), Boolean(ride.organization_id));

    const docs = await sr.LegalDocument.filter(
      { document_key: "location_data_notice", published: true }, "-effective_at", 1,
    );
    const notice = (docs ?? [])[0];
    if (!notice) {
      return fail("location_notice_missing", "The location notice has not been published yet.", 409);
    }
    if (body.acknowledged !== true) {
      return fail("acknowledgement_required", "Read the location notice before turning this on.", 400);
    }

    const now = new Date().toISOString();

    const existing = await sr.TrackingSession.filter({ ride_request_id: rideId }, "-granted_at", 1);
    const live = (existing ?? [])[0];
    if (live && !live.revoked_at && !live.ended_at) {
      return ok({ tracking_session_id: live.id, status: "already_on", audiences: live.audiences });
    }

    const session = await sr.TrackingSession.create({
      ride_request_id: rideId,
      granted_by_user_id: ctx.principal.userId,
      granted_at: now,
      audiences,
      started_at: now,
      consent_document_version: notice.version,
      ping_count: 0,
    });

    // One token per audience, each expiring with the trip.
    const expiresAt = linkExpiry(String(ride.requested_pickup_at ?? now), ride.arrival_by_at, now);
    const links: { audience: string; token: string; expires_at: string }[] = [];
    for (const audience of audiences) {
      const token = secureToken(32);
      await sr.TrackingLink.create({
        ride_request_id: rideId,
        tracking_session_id: session.id,
        token,
        audience,
        issued_to_user_id: audience === "rider" || audience === "guardian" ? ctx.principal.userId : "",
        issued_at: now,
        expires_at: expiresAt,
        read_count: 0,
        reads_in_window: 0,
        reads_window_started_at: now,
      });
      links.push({ audience, token, expires_at: expiresAt });
    }

    await audit(ctx, {
      event_type: "location.consent_granted", action: "create",
      subject_entity: "TrackingSession", subject_id: session.id,
      metadata: { ride_request_id: rideId, audiences: audiences.join(","), notice_version: notice.version },
    });

    return ok({
      tracking_session_id: session.id,
      audiences,
      links,
      expires_at: expiresAt,
      message:
        "Location sharing is on for this trip only. It stops when the ride ends, and you can turn it off at any time.",
    }, 201);
  } catch (e) {
    console.error("start_location_sharing_failed", String(e));
    return serverError();
  }
}
