/**
 * Record that part or all of a pledge actually arrived, and let staff verify it.
 *
 * A shortfall produces a status and nothing else. `summariseFulfillment` floors
 * the outstanding figure at zero on purpose: there is no such thing as owing us
 * hours, and no such thing as a negative balance in this system.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { summariseFulfillment, type FulfillmentRecord } from "../../shared/contributions.ts";
import { scanStatusFor, unavailableScanner, validateUpload } from "../../shared/uploads.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const sr = ctx.base44.asServiceRole.entities;
    const pledgeId = String(body.pledge_id ?? "");

    const rows = await sr.ContributionPledge.filter({ id: pledgeId }, undefined, 1);
    const pledge = (rows ?? [])[0];
    if (!pledge) return notFound("That pledge does not exist.");

    const isOrgMember = ctx.principal.organizationIds.includes(pledge.organization_id) &&
      (hasRole(ctx.principal, "org_admin") || hasRole(ctx.principal, "org_scheduler"));
    const isStaff = hasRole(ctx.principal, "platform_admin");
    if (!isOrgMember && !isStaff) return notFound("That pledge does not exist.");

    const today = todayISO();
    const now = new Date().toISOString();
    const action = String(body.action ?? "record");

    if (action === "verify") {
      if (!isStaff) return forbidden("Only a platform administrator can verify a contribution.");
      const fulfillmentId = String(body.fulfillment_id ?? "");
      const fRows = await sr.ContributionFulfillment.filter({ id: fulfillmentId }, undefined, 1);
      const record = (fRows ?? [])[0];
      if (!record || record.pledge_id !== pledgeId) return notFound("That record does not exist.");

      await sr.ContributionFulfillment.update(fulfillmentId, {
        verified: body.verified !== false,
        verified_by_email: ctx.principal.email,
        verified_at: now,
        estimated_value_cents: body.estimated_value_cents !== undefined
          ? Number(body.estimated_value_cents)
          : record.estimated_value_cents,
      });
      await audit(ctx, {
        event_type: "contribution.fulfillment_verified", action: "approve",
        subject_entity: "ContributionFulfillment", subject_id: fulfillmentId,
        metadata: { pledge_id: pledgeId },
      });
    } else {
      if (pledge.status !== "accepted" && pledge.status !== "partially_fulfilled") {
        return fail("pledge_not_accepted", "This pledge has not been accepted yet, so there is nothing to record against.", 409);
      }
      const quantity = Number(body.quantity ?? 0);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return fail("invalid_quantity", "Enter how much arrived.", 400);
      }
      const occurredOn = String(body.occurred_on ?? today);
      if (occurredOn > today) return fail("in_the_future", "That date has not happened yet.", 400);

      let scanStatus = "not_applicable";
      const evidence = body.evidence_reference ? String(body.evidence_reference) : "";
      if (evidence) {
        if (/^https?:\/\//i.test(evidence)) {
          return fail("public_url_rejected", "Evidence must be a private upload, not a link.", 400);
        }
        const verdict = validateUpload({
          filename: String(body.filename ?? ""),
          contentType: String(body.content_type ?? ""),
          sizeBytes: Number(body.size_bytes ?? 0),
          purpose: "incident_evidence",
        });
        if (!verdict.ok) return fail(verdict.code, verdict.message, 400);
        scanStatus = scanStatusFor((await unavailableScanner.scan(evidence)).verdict);
      }

      const created = await sr.ContributionFulfillment.create({
        pledge_id: pledgeId,
        organization_id: pledge.organization_id,
        quantity,
        unit_label: pledge.unit_label,
        occurred_on: occurredOn,
        recorded_by_user_id: ctx.principal.userId,
        recorded_by_email: ctx.principal.email,
        description: body.description ? String(body.description) : "",
        evidence_reference: evidence || undefined,
        evidence_content_type: body.content_type ? String(body.content_type) : undefined,
        evidence_scan_status: scanStatus,
        verified: false,
      });
      await audit(ctx, {
        event_type: "contribution.fulfillment_recorded", action: "create",
        subject_entity: "ContributionFulfillment", subject_id: created.id,
        metadata: { pledge_id: pledgeId, quantity, scan_status: scanStatus },
      });
    }

    // Recompute the pledge's standing from what has actually been recorded.
    const all = await sr.ContributionFulfillment.filter({ pledge_id: pledgeId }, "occurred_on", 500);
    const records: FulfillmentRecord[] = (all ?? []).map((r: Record<string, unknown>) => ({
      pledge_id: pledgeId,
      quantity: Number(r.quantity ?? 0),
      occurred_on: String(r.occurred_on),
      evidence_reference: r.evidence_reference as string | undefined,
      verified: r.verified === true,
    }));
    const summary = summariseFulfillment(
      Number(pledge.quantity),
      records,
      pledge.status,
      today,
      pledge.ends_on ? String(pledge.ends_on) : undefined,
    );
    if (summary.status !== pledge.status) {
      await sr.ContributionPledge.update(pledgeId, { status: summary.status });
    }

    return ok({
      pledge_id: pledgeId,
      ...summary,
      rider_access_effect: "none",
    });
  } catch (e) {
    console.error("record_contribution_fulfillment_failed", String(e));
    return serverError();
  }
}
