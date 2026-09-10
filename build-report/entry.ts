/**
 * The single reporting endpoint.
 *
 * Scope is decided from the caller's role, never from what they ask for. An
 * organization gets its own participants; a partner gets its own destinations;
 * staff get everything. Suppression is applied for every audience except staff,
 * and a suppressed cell is reported as the word, so a reader can tell the
 * difference between "none" and "too few to show".
 *
 * Minors, exact addresses, trip purposes, and incident narratives never appear.
 */
import { fail, forbidden, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { buildReport, toCsv, type Audience, type RideFact } from "../../shared/reporting.ts";

const MAX_RANGE_DAYS = 400;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const from = String(body.from ?? "");
    const to = String(body.to ?? "");
    if (!from || !to || to <= from) return fail("invalid_range", "Give a from and to date, with to after from.", 400);
    if ((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      return fail("range_too_wide", `Report on at most ${MAX_RANGE_DAYS} days at a time.`, 400);
    }

    const wantsCsv = body.format === "csv";
    const sr = ctx.base44.asServiceRole.entities;

    // Scope comes from who the caller is, not from what they requested.
    const isStaff = hasRole(ctx.principal, "dispatcher") || hasRole(ctx.principal, "safety_staff") ||
      hasRole(ctx.principal, "platform_admin");
    const requestedOrg = body.organization_id ? String(body.organization_id) : "";
    const requestedPartner = body.partner_id ? String(body.partner_id) : "";

    let audience: Audience;
    let organizationId: string | undefined;
    let partnerId: string | undefined;

    if (isStaff) {
      audience = "staff";
      organizationId = requestedOrg || undefined;
      partnerId = requestedPartner || undefined;
    } else if (hasRole(ctx.principal, "org_admin") || hasRole(ctx.principal, "org_scheduler")) {
      audience = "organization";
      // Ignore whatever they asked for; pin to an org they actually belong to.
      organizationId = requestedOrg && ctx.principal.organizationIds.includes(requestedOrg)
        ? requestedOrg
        : ctx.principal.organizationIds[0];
      if (!organizationId) return forbidden("You are not an approved member of any organization.");
      if (requestedPartner) {
        return forbidden("An organization report cannot be scoped to a partner's activity.");
      }
    } else {
      await audit(ctx, {
        event_type: "report.build", action: "read", outcome: "denied", reason_code: "no_reporting_role",
      });
      return forbidden("You do not have access to reports.");
    }

    // CSV of a scoped report is a sensitive export and needs a stated purpose.
    const purpose = String(body.purpose ?? "").trim();
    if (wantsCsv && purpose.length < 15) {
      return fail("purpose_required", "Write why you need this export. At least 15 characters.", 400);
    }

    const rides = await sr.RideRequest.filter(
      { requested_pickup_at: { $gte: from, $lte: to } }, "requested_pickup_at", 2000,
    );

    // Build facts. Only fields the report is allowed to see are copied across —
    // no addresses, no coordinates, no phone numbers, no notes.
    const facts: RideFact[] = [];
    for (const ride of rides ?? []) {
      let ridePartnerId: string | undefined;
      if (ride.destination_location_id) {
        const locations = await sr.ResourceLocation.filter({ id: ride.destination_location_id }, undefined, 1);
        ridePartnerId = (locations ?? [])[0]?.partner_id;
      }
      const needs = await sr.RideNeed.filter({ ride_request_id: ride.id });
      facts.push({
        ride_id: ride.id,
        rider_user_id: ride.rider_user_id,
        organization_id: ride.organization_id,
        destination_location_id: ride.destination_location_id,
        partner_id: ridePartnerId,
        resource_category: ride.resource_category,
        pickup_zip: ride.pickup_zip,
        status: ride.status,
        requested_pickup_at: ride.requested_pickup_at,
        arrival_by_at: ride.arrival_by_at,
        completed_at: ride.completed_at,
        passenger_count: ride.passenger_count,
        rider_kind: ride.rider_kind,
        accommodations_requested: (needs ?? []).map((n: { need: string }) => n.need),
        accommodations_fulfilled: (needs ?? [])
          .filter((n: { fulfilled?: boolean }) => n.fulfilled === true)
          .map((n: { need: string }) => n.need),
        miles: ride.reported_miles ? Number(ride.reported_miles) : undefined,
        volunteer_minutes: ride.volunteer_minutes ? Number(ride.volunteer_minutes) : undefined,
      });
    }

    const report = buildReport(facts, { audience, organizationId, partnerId, from, to });

    // Contribution and donation figures, scoped the same way.
    const pledgeFilter: Record<string, unknown> = organizationId ? { organization_id: organizationId } : {};
    const pledges = await sr.ContributionPledge.filter(pledgeFilter, "-created_date", 500);
    const fulfillments = await sr.ContributionFulfillment.filter(pledgeFilter, "-occurred_on", 500);
    const contributions = {
      pledges_submitted: (pledges ?? []).length,
      pledges_accepted: (pledges ?? []).filter((p: { status: string }) => p.status === "accepted").length,
      pledges_fulfilled: (pledges ?? []).filter((p: { status: string }) => p.status === "fulfilled").length,
      volunteer_hours_recorded: (fulfillments ?? [])
        .filter((f: { unit_label?: string }) => (f.unit_label ?? "").toLowerCase().includes("hour"))
        .reduce((n: number, f: { quantity: number }) => n + Number(f.quantity ?? 0), 0),
      // Stated every time these numbers are shown.
      effect_on_ride_access: "none",
    };

    await audit(ctx, {
      event_type: wantsCsv ? "export.sensitive" : "report.build",
      action: wantsCsv ? "export" : "read",
      justification: wantsCsv ? purpose : undefined,
      metadata: {
        audience, organization_id: organizationId ?? "", partner_id: partnerId ?? "",
        from, to, rides_considered: facts.length,
        suppressed_cells: report.suppressed_cells.length,
        format: wantsCsv ? "csv" : "json",
      },
    });

    if (wantsCsv) {
      return ok({
        format: "csv",
        filename: `scoop-me-report-${from}-to-${to}.csv`,
        csv: toCsv(report),
        purpose,
        handling_notice:
          "Suppressed cells are written as the word 'suppressed', not as zero. Do not republish them as zero.",
      });
    }

    return ok({
      ...report,
      contributions,
      donations: { enabled: false, note: "Donations are switched off in this pilot." },
      tips: { enabled: false, note: "Driver tips are switched off in this pilot." },
    });
  } catch (e) {
    console.error("build_report_failed", String(e));
    return serverError();
  }
}
