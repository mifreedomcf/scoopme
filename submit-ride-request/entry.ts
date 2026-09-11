/**
 * Create and submit a scheduled ride request.
 *
 * Everything the client sends is untrusted: fields are allowlisted, geography is
 * re-derived server-side, and the resulting record is written with the service
 * role so the client cannot set status, flags, or the verification code.
 */
import { fail, isRateLimited, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, loadGates, todayISO } from "../../shared/runtime.ts";
import { stripToAccepted, validateRideRequest } from "../../shared/validation.ts";
import { distanceMiles, PLACEHOLDER_BOUNDARY, validateServiceArea } from "../../shared/geo.ts";
import { mockGeocoder } from "../../shared/mock-geocoder.ts";
import { canFulfillRides } from "../../shared/flags.ts";
import { hasRole } from "../../shared/authz.ts";
import { idempotencyKey } from "../../shared/ids.ts";
import { renderTemplate } from "../../shared/notifications.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (ctx.principal.suspended) return fail("account_suspended", "This account is suspended.", 403);

    const raw = await readJson(req);
    if (!raw) return fail("invalid_body", "Send a JSON object.", 400);
    const input = stripToAccepted(raw);

    const config = await loadConfig(ctx);
    const gates = await loadGates(ctx);
    const now = new Date();

    // Rate limit per requester.
    const recent = await ctx.base44.asServiceRole.entities.RideRequest.filter(
      { requested_by_user_id: ctx.principal.userId },
      "-created_date",
      50,
    );
    if (
      isRateLimited({
        eventTimestamps: (recent ?? []).map((r: { created_date: string }) => r.created_date),
        windowMs: 24 * 3_600_000,
        limit: Number(config.ride_request_rate_limit_per_day),
        now,
      })
    ) {
      await audit(ctx, { event_type: "ride.submit", action: "create", outcome: "denied", reason_code: "rate_limited" });
      return fail("rate_limited", "You have reached today's request limit. Call the support line if this is urgent.", 429);
    }

    const validation = validateRideRequest(input, config, now);
    if (!validation.ok) {
      return fail("validation_failed", "Some answers need fixing.", 400, validation.errors);
    }

    // Who is the rider, and is this requester allowed to act for them?
    let riderUserId = ctx.principal.userId;
    if (input.requested_by_kind === "org_scheduler") {
      if (!hasRole(ctx.principal, "org_scheduler") && !hasRole(ctx.principal, "org_admin")) {
        return fail("forbidden", "You are not an approved scheduler for this organization.", 403);
      }
      if (!ctx.principal.organizationIds.includes(String(input.organization_id))) {
        return fail("forbidden", "You are not an approved scheduler for this organization.", 403);
      }
      const auths = await ctx.base44.asServiceRole.entities.OrganizationParticipantAuthorization.filter({
        id: input.participant_authorization_id,
      });
      const auth = (auths ?? [])[0];
      if (
        !auth ||
        auth.organization_id !== input.organization_id ||
        auth.status !== "active" ||
        (auth.expires_at && auth.expires_at < now.toISOString())
      ) {
        return fail(
          "participant_authorization_invalid",
          "This participant has not given your organization current authorization to request rides for them.",
          403,
        );
      }
      riderUserId = auth.participant_user_id;
    }

    // Resolve the destination. A pilot destination must be a published, flagged location.
    let destinationAddress = input.destination_address ?? "";
    let destinationLocation: Record<string, unknown> | null = null;
    if (input.destination_location_id) {
      const rows = await ctx.base44.asServiceRole.entities.ResourceLocation.filter({ id: input.destination_location_id });
      destinationLocation = (rows ?? [])[0] ?? null;
      if (!destinationLocation || destinationLocation.status !== "published") {
        return fail("destination_unavailable", "That destination is not available right now.", 400);
      }
      destinationAddress = [
        destinationLocation.street_address,
        destinationLocation.city,
        destinationLocation.state,
        destinationLocation.zip_code,
      ]
        .filter(Boolean)
        .join(", ");
    }

    // Geography is re-derived here. The client's coordinates are ignored.
    const geocoder = mockGeocoder; // Milestone 5 swaps in the live provider.
    const pickupGeo = await geocoder.geocode(String(input.pickup_address ?? ""));
    const destGeo = await geocoder.geocode(destinationAddress);

    const pickupVerdict = validateServiceArea({
      geocode: pickupGeo,
      boundary: PLACEHOLDER_BOUNDARY,
      kind: "pickup",
      allowedDestinationZips: config.allowed_destination_zip_codes,
      allowedPickupZips: config.allowed_pickup_zip_codes,
      serviceAreaCity: config.service_area_city,
      serviceAreaState: config.service_area_state,
    });
    const destVerdict = validateServiceArea({
      geocode: destGeo,
      boundary: PLACEHOLDER_BOUNDARY,
      kind: "destination",
      allowedDestinationZips: config.allowed_destination_zip_codes,
      allowedPickupZips: config.allowed_pickup_zip_codes,
      serviceAreaCity: config.service_area_city,
      serviceAreaState: config.service_area_state,
    });

    if (pickupVerdict.status === "outside_service_area") {
      await audit(ctx, {
        event_type: "ride.submit", action: "create", outcome: "denied",
        reason_code: "pickup_outside_service_area", metadata: { reasons: pickupVerdict.reasons.join(",") },
      });
      return fail(
        "pickup_outside_service_area",
        `Pickups are only available inside ${config.service_area_label} during this pilot.`,
        400,
      );
    }
    if (destVerdict.status === "outside_service_area") {
      await audit(ctx, {
        event_type: "ride.submit", action: "create", outcome: "denied",
        reason_code: "destination_outside_pilot_area", metadata: { reasons: destVerdict.reasons.join(",") },
      });
      return fail(
        "destination_outside_pilot_area",
        `During this pilot we only drive to approved locations in ${config.allowed_destination_zip_codes.join(", ")}.`,
        400,
      );
    }

    const flags = [
      ...validation.flags,
      ...pickupVerdict.reasons.map((r) => `pickup:${r}`),
      ...destVerdict.reasons.map((r) => `destination:${r}`),
    ];
    const needsHuman = pickupVerdict.requiresHumanReview || destVerdict.requiresHumanReview;

    const fulfillment = canFulfillRides(config, gates, todayISO());

    const created = await ctx.base44.asServiceRole.entities.RideRequest.create({
      rider_user_id: riderUserId,
      rider_kind: "adult",
      requested_by_user_id: ctx.principal.userId,
      requested_by_kind: input.requested_by_kind ?? "self",
      organization_id: input.organization_id,
      participant_authorization_id: input.participant_authorization_id,

      status: "eligibility_review",
      status_reason_code: needsHuman ? "geography_needs_review" : "queued_for_review",

      pickup_address: input.pickup_address,
      pickup_zip: pickupGeo.zip,
      pickup_area_label: pickupGeo.areaLabel ?? "Detroit",
      pickup_latitude: pickupGeo.point?.lat,
      pickup_longitude: pickupGeo.point?.lng,
      pickup_geo_status: pickupVerdict.status,

      destination_location_id: input.destination_location_id,
      destination_address: destinationAddress,
      destination_zip: destGeo.zip ?? destinationLocation?.zip_code,
      destination_area_label: (destinationLocation?.name as string) ?? destGeo.areaLabel ?? "Detroit",
      destination_latitude: destGeo.point?.lat,
      destination_longitude: destGeo.point?.lng,
      destination_geo_status: destVerdict.status,
      resource_category: input.resource_category,

      requested_pickup_at: input.requested_pickup_at,
      arrival_by_at: input.arrival_by_at,
      flexible_window_minutes: input.flexible_window_minutes ?? 30,
      passenger_count: input.passenger_count ?? 1,
      language_preference: input.language_preference ?? "en",
      assistance_level: input.assistance_level ?? "curb_to_curb",
      service_animal: Boolean(input.service_animal),
      contact_phone: input.contact_phone,
      operational_notes: input.operational_notes,

      fare_charged_cents: 0,
      // Straight-line distance only, for volunteer-mileage reporting. This is
      // never a tracked route and is not recomputed during the ride.
      reported_miles:
        pickupGeo.point && destGeo.point
          ? Math.round(distanceMiles(pickupGeo.point, destGeo.point) * 10) / 10
          : undefined,
      eligibility_flags: flags,
      submitted_at: now.toISOString(),
    });

    for (const need of input.needs ?? []) {
      await ctx.base44.asServiceRole.entities.RideNeed.create({
        ride_request_id: created.id,
        need: need.need,
        detail: need.detail,
        quantity: need.quantity ?? 1,
        is_hard_requirement: true,
      });
    }

    await ctx.base44.asServiceRole.entities.RideEvent.create({
      ride_request_id: created.id,
      event_type: "transition",
      from_state: "draft",
      to_state: "eligibility_review",
      actor_user_id: ctx.principal.userId,
      actor_role: input.requested_by_kind ?? "rider",
      reason_code: "submitted",
      occurred_at: now.toISOString(),
    });

    await audit(ctx, {
      event_type: "ride.submit", action: "create", subject_entity: "RideRequest", subject_id: created.id,
      to_state: "eligibility_review", metadata: { flags: flags.join(","), fulfillment: fulfillment.code },
    });

    const rendered = renderTemplate("request_received", {
      brandName: String(config.brand_name),
      genericDestinationLabel: "your scheduled ride",
    });
    await ctx.base44.asServiceRole.entities.Notification.create({
      recipient_user_id: riderUserId,
      channel: "in_app",
      template_key: "request_received",
      subject: rendered.subject,
      body: rendered.body,
      ride_request_id: created.id,
      idempotency_key: idempotencyKey(["request_received", created.id, riderUserId]),
      status: "queued",
      queued_at: now.toISOString(),
    });

    return ok(
      {
        ride_request_id: created.id,
        status: "eligibility_review",
        needs_human_review: needsHuman,
        fulfillment_available: fulfillment.allowed,
        message: fulfillment.allowed
          ? "Your request is in. A coordinator will review it and confirm."
          : "Your request is saved and will be reviewed. Rides are not being driven yet while the pilot completes its safety and insurance checks.",
        rider_pays_cents: 0,
      },
      201,
    );
  } catch (e) {
    console.error("submit_ride_request_failed", String(e));
    return serverError();
  }
}
