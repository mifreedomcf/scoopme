/**
 * Idempotent seeding for the closed pilot.
 *
 * Creates the active SystemConfig row, the launch-gate checklist, the draft
 * legal documents, and the pilot resource partner. Every operational detail the
 * platform does not actually know — the partner's street address, hours,
 * contact, pickup instructions, inventory notes, and public description — is
 * left blank for an administrator to fill in. Nothing here is guessed.
 *
 * Optional demo data is clearly fictional and never enabled by default.
 */
import { fail, forbidden, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { SAFE_DEFAULT_CONFIG } from "../../shared/constants.ts";
import gatesSeed from "./gates.json" with { type: "json" };
import legalSeed from "./legal-documents.json" with { type: "json" };
import demoSeed from "./demo-data.json" with { type: "json" };

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "platform_admin")) return forbidden("Only platform administrators can seed the pilot.");

    const body = await readJson(req);
    const includeDemoData = body?.include_demo_data === true;

    const created: Record<string, number> = { config: 0, gates: 0, legal_documents: 0, partners: 0, locations: 0, demo: 0 };
    const sr = ctx.base44.asServiceRole.entities;

    // 1. Configuration singleton, at the safe defaults.
    const existingConfig = await sr.SystemConfig.filter({ config_key: "active" }, undefined, 1);
    if ((existingConfig ?? []).length === 0) {
      await sr.SystemConfig.create({ ...SAFE_DEFAULT_CONFIG });
      created.config = 1;
    }

    // 2. Launch gates.
    for (const gate of gatesSeed as Record<string, unknown>[]) {
      const rows = await sr.LaunchGate.filter({ gate_key: gate.gate_key }, undefined, 1);
      if ((rows ?? []).length === 0) {
        await sr.LaunchGate.create({ ...gate, status: "not_started" });
        created.gates += 1;
      }
    }

    // 3. Draft legal documents.
    for (const doc of legalSeed as Record<string, unknown>[]) {
      const rows = await sr.LegalDocument.filter({ document_key: doc.document_key, version: doc.version }, undefined, 1);
      if ((rows ?? []).length === 0) {
        await sr.LegalDocument.create({ ...doc, effective_at: new Date().toISOString() });
        created.legal_documents += 1;
      }
    }

    // 4. Pilot resource partner. Only what is actually known is filled in.
    const partnerSlug = "detroit-heals-detroit";
    const partnerRows = await sr.ResourcePartner.filter({ slug: partnerSlug }, undefined, 1);
    let partner = (partnerRows ?? [])[0];
    if (!partner) {
      partner = await sr.ResourcePartner.create({
        slug: partnerSlug,
        name: "Detroit Heals Detroit",
        public_description: "",          // admin-editable; blank until the partner approves wording
        acknowledgement_text: "",        // published only when acknowledgement_approved is true
        acknowledgement_approved: false,
        contact_name: "",
        contact_email: "",
        contact_phone: "",
        escalation_contact: "",
        website_url: "",
        mou_on_file: false,
        status: "draft",                 // not published until the MOU gate closes
      });
      created.partners = 1;
    }

    const locationRows = await sr.ResourceLocation.filter({ partner_id: partner.id }, undefined, 5);
    if ((locationRows ?? []).length === 0) {
      await sr.ResourceLocation.create({
        partner_id: partner.id,
        name: "Free fridge and mutual-aid site (48205)",
        resource_categories: ["free_fridge", "mutual_aid_supplies", "food_pantry"],
        street_address: "",              // ADMIN-EDITABLE — deliberately blank, not guessed
        city: "Detroit",
        state: "MI",
        zip_code: "48205",
        geocode_status: "not_geocoded",
        operating_hours_text: "",        // ADMIN-EDITABLE
        pickup_instructions: "",         // ADMIN-EDITABLE
        inventory_notes: "",             // ADMIN-EDITABLE
        accessibility_notes: "",
        is_pilot_destination: true,
        status: "draft",
      });
      created.locations = 1;
    }

    // 5. Optional, clearly fictional demo data for QA. Never real people.
    if (includeDemoData) {
      for (const row of (demoSeed as { entity: string; data: Record<string, unknown> }[])) {
        await sr[row.entity].create(row.data);
        created.demo += 1;
      }
    }

    await audit(ctx, {
      event_type: "admin.seed", action: "create",
      metadata: { ...created, demo_included: includeDemoData },
    });

    return ok({
      created,
      next_steps: [
        "Open Admin settings and set the legal operator name.",
        "Fill in the partner's street address, hours, contact, pickup instructions, and public description with the partner's confirmation. Nothing was guessed.",
        "Work through the launch checklist. Ride fulfillment stays off until the required gates are complete.",
        "Send every draft legal document to counsel and the insurer before publishing anything as final.",
      ],
    });
  } catch (e) {
    console.error("seed_pilot_data_failed", String(e));
    return serverError();
  }
}
