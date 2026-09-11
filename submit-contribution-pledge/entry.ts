/**
 * An organization offers hours or goods.
 *
 * The server refuses wording that ties the offer to anyone's ride, because a
 * pledge phrased as a condition on access is not a pledge. No field written
 * here is read by matching or eligibility, and there is no balance to go
 * negative.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { validatePledge } from "../../shared/contributions.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "org_admin") && !hasRole(ctx.principal, "org_scheduler")) {
      return forbidden("Only an approved organization member can make a pledge.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const organizationId = String(body.organization_id ?? "");
    if (!ctx.principal.organizationIds.includes(organizationId)) {
      return forbidden("You are not an approved member of that organization.");
    }

    const config = await loadConfig(ctx);
    if (!config.organization_in_kind_contributions_enabled) {
      return fail(
        "contributions_disabled",
        "Organization pledges are switched off right now. This has no effect on anyone's rides.",
        409,
      );
    }

    const sr = ctx.base44.asServiceRole.entities;
    const items = await sr.ContributionCatalogItem.filter({ id: String(body.catalog_item_id ?? "") }, undefined, 1);
    const item = (items ?? [])[0] ?? null;

    const today = todayISO();
    const validation = validatePledge(
      {
        catalog_item_id: String(body.catalog_item_id ?? ""),
        quantity: Number(body.quantity ?? 0),
        note: body.note ? String(body.note) : undefined,
        starts_on: body.starts_on ? String(body.starts_on) : undefined,
        ends_on: body.ends_on ? String(body.ends_on) : undefined,
      },
      item,
      today,
    );
    if (!validation.ok) {
      const conditional = validation.errors.some((e) => e.code === "conditional_language");
      if (conditional) {
        await audit(ctx, {
          event_type: "contribution.pledge_rejected", action: "create", outcome: "denied",
          reason_code: "conditional_language", metadata: { organization_id: organizationId },
        });
      }
      return fail("validation_failed", "This pledge needs a change before we can accept it.", 400, validation.errors);
    }

    const created = await sr.ContributionPledge.create({
      organization_id: organizationId,
      catalog_item_id: item!.id,
      pledged_by_user_id: ctx.principal.userId,
      pledged_by_email: ctx.principal.email,
      kind: item!.kind,
      quantity: Number(body.quantity),
      unit_label: item!.unit_label,
      note: body.note ? String(body.note) : "",
      starts_on: body.starts_on ? String(body.starts_on) : undefined,
      ends_on: body.ends_on ? String(body.ends_on) : undefined,
      status: "submitted",
    });

    await audit(ctx, {
      event_type: "contribution.pledge_submitted", action: "create",
      subject_entity: "ContributionPledge", subject_id: created.id,
      metadata: { organization_id: organizationId, kind: item!.kind, quantity: Number(body.quantity) },
    });

    return ok({
      pledge_id: created.id,
      status: "submitted",
      warnings: validation.warnings,
      unconditional_notice:
        "Thank you. This is voluntary. It does not affect any participant's eligibility, priority, or access, and if it does not come through there is no debt, penalty, or restriction of any kind.",
      tax_notice:
        "We cannot tell you whether this is tax deductible. Ask your own adviser.",
    }, 201);
  } catch (e) {
    console.error("submit_contribution_pledge_failed", String(e));
    return serverError();
  }
}
