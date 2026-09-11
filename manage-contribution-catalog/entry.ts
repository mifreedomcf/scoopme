/**
 * The operator maintains the list of things organizations could help with.
 *
 * A target quantity is a request, not an obligation, and nothing in this
 * catalogue is connected to anyone's access to a ride.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

const KINDS = ["volunteer_hours", "supplies", "equipment", "space", "services"];
const EDITABLE = ["kind", "title", "description", "unit_label", "target_quantity", "active", "display_order"];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only platform administrators can change the list of needs.");
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const sr = ctx.base44.asServiceRole.entities;
    const itemId = body.item_id ? String(body.item_id) : "";

    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.changes ?? {})) {
      if (EDITABLE.includes(k)) patch[k] = v;
    }
    if (patch.kind && !KINDS.includes(String(patch.kind))) {
      return fail("invalid_kind", "That is not a kind of contribution we track.", 400);
    }

    if (itemId) {
      const rows = await sr.ContributionCatalogItem.filter({ id: itemId }, undefined, 1);
      if ((rows ?? []).length === 0) return notFound("That item does not exist.");
      await sr.ContributionCatalogItem.update(itemId, patch);
      await audit(ctx, {
        event_type: "contribution.catalog_update", action: "update",
        subject_entity: "ContributionCatalogItem", subject_id: itemId,
        metadata: { fields: Object.keys(patch).join(",") },
      });
      return ok({ item_id: itemId, updated: Object.keys(patch) });
    }

    for (const required of ["kind", "title", "unit_label"]) {
      if (!patch[required]) return fail("missing_fields", `${required} is required.`, 400);
    }
    const created = await sr.ContributionCatalogItem.create({ active: true, display_order: 100, ...patch });
    await audit(ctx, {
      event_type: "contribution.catalog_create", action: "create",
      subject_entity: "ContributionCatalogItem", subject_id: created.id,
    });
    return ok({ item_id: created.id }, 201);
  } catch (e) {
    console.error("manage_contribution_catalog_failed", String(e));
    return serverError();
  }
}
