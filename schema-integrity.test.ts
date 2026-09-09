/**
 * Checks the entity definitions themselves, so a future edit cannot quietly
 * open up a permission or start storing something we promised not to store.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "base44", "entities");
const files = readdirSync(DIR).filter((f: string) => f.endsWith(".jsonc"));

interface EntitySchema {
  name: string;
  type: string;
  properties: Record<string, Record<string, unknown> & { rls?: Record<string, unknown>; enum?: string[]; format?: string; description?: string; default?: unknown; minimum?: number; maximum?: number }>;
  rls: Record<string, unknown>;
  schema?: unknown;
}

function load(file: string): EntitySchema {
  // Entity files are strict JSON with a .jsonc extension; no comments are used
  // inside them precisely so they stay machine-checkable.
  return JSON.parse(readFileSync(join(DIR, file), "utf8"));
}

const entities = files.map((f: string) => ({ file: f, schema: load(f) }));

/** Entities where a client must never be able to write, at all. */
const WRITE_DENIED = [
  "SystemConfig", "LaunchGate", "AuditLog", "DataRetentionHold", "RoleAssignment",
  "RideRequest", "RideNeed", "RideOffer", "RideAssignment", "RideEvent",
  "DriverProfile", "DriverCredential", "Vehicle", "VehicleCapability",
  "SafetyIncident", "IncidentAttachment", "Notification", "LegalDocument", "LegalAcceptance",
  "Organization", "OrganizationMember", "OrganizationParticipantAuthorization",
  "ResourcePartner", "ResourceLocation",
];

describe("entity schemas", () => {
  it("uses kebab-case file names matching PascalCase entity names", () => {
    for (const { file, schema } of entities) {
      const expected = schema.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() + ".jsonc";
      expect(file, `${schema.name} should live in ${expected}`).toBe(expected);
      expect(schema.name).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it("puts type and properties at the top level, never inside a nested schema object", () => {
    for (const { file, schema } of entities) {
      expect(schema.type, file).toBe("object");
      expect(schema.properties, file).toBeTruthy();
      expect(schema.schema, file).toBeUndefined();
    }
  });

  it("declares row-level security on every entity", () => {
    for (const { file, schema } of entities) {
      expect(schema.rls, `${file} has no rls block, so every record would be world-readable`).toBeTruthy();
      for (const op of ["create", "read", "update", "delete"]) {
        expect(schema.rls[op], `${file}.rls.${op}`).toBeDefined();
      }
    }
  });

  it("denies client writes on every entity that only a backend function may change", () => {
    for (const name of WRITE_DENIED) {
      const entry = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === name);
      expect(entry, `${name} entity is missing`).toBeTruthy();
      const rls = entry!.schema.rls as Record<string, unknown>;
      expect(rls.update, `${name}.rls.update must be false`).toBe(false);
      expect(rls.delete, `${name}.rls.delete must be false`).toBe(false);
    }
  });

  it("never allows anyone to delete an audit or ride event record", () => {
    for (const name of ["AuditLog", "RideEvent", "LegalAcceptance"]) {
      const entry = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === name)!;
      expect(entry.schema.rls.delete).toBe(false);
      expect(entry.schema.rls.update).toBe(false);
      expect(entry.schema.rls.create).toBe(false);
    }
  });

  it("declares no field that would store a full SSN, a card number, or a full licence number", () => {
    const banned = /(^|_)(ssn|social_security|card_number|cvv|full_license_number|license_number)$/i;
    for (const { file, schema } of entities) {
      for (const field of Object.keys(schema.properties)) {
        expect(banned.test(field), `${file} declares ${field}`).toBe(false);
      }
    }
  });

  it("pins the rider fare to zero", () => {
    const ride = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === "RideRequest")!;
    expect(ride.schema.properties.fare_charged_cents.maximum).toBe(0);
    expect(ride.schema.properties.fare_charged_cents.default).toBe(0);
  });

  it("field-level-secures every exact address, coordinate, contact number and code on a ride", () => {
    const ride = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === "RideRequest")!.schema;
    for (const field of [
      "pickup_address", "destination_address", "pickup_latitude", "pickup_longitude",
      "destination_latitude", "destination_longitude", "contact_phone", "verification_code", "operational_notes",
    ]) {
      expect(ride.properties[field].rls?.read, `${field} needs field-level read security`).toBeTruthy();
    }
  });

  it("stores credential documents as private references, never as public URLs", () => {
    const cred = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === "DriverCredential")!.schema;
    expect(cred.properties.document_reference.format).not.toBe("uri");
    expect(cred.properties.document_reference.description).toMatch(/never a public url/i);
    const attachment = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === "IncidentAttachment")!.schema;
    expect(attachment.properties.file_reference.format).not.toBe("uri");
  });

  it("keeps the minor workflow present but unreachable, with its own credential tier", () => {
    const config = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === "SystemConfig")!.schema;
    expect(config.properties.minor_rides_enabled.default).toBe(false);
    expect(config.properties.minimum_minor_transport_driver_age.minimum).toBe(25);
    expect(config.properties.minimum_driver_age.minimum).toBe(21);

    const profile = entities.find((e: { file: string; schema: EntitySchema }) => e.schema.name === "DriverProfile")!.schema;
    expect(profile.properties.approval_tier.enum).toContain("minor_transport_approved");
  });
});

describe("seed data", () => {
  const seedDir = join(process.cwd(), "base44", "functions", "seed-pilot-data");
  const gates = JSON.parse(readFileSync(join(seedDir, "gates.json"), "utf8"));
  const legal = JSON.parse(readFileSync(join(seedDir, "legal-documents.json"), "utf8"));
  const demo = JSON.parse(readFileSync(join(seedDir, "demo-data.json"), "utf8"));

  it("covers every compliance checklist category", () => {
    const categories = new Set(gates.map((g: { category: string }) => g.category));
    for (const required of [
      "regulatory", "insurance", "driver_auto_policy", "legal_documents", "background_checks",
      "mvr_monitoring", "child_safeguarding", "child_restraint", "payments_tax",
      "privacy_security", "support_coverage", "partner_mou",
    ]) {
      expect(categories.has(required), `missing gate category ${required}`).toBe(true);
    }
    for (const g of gates) expect(g.status ?? "not_started").not.toBe("complete");
  });

  it("marks every legal document as an unapproved draft carrying the review banner", () => {
    expect(legal.length).toBeGreaterThanOrEqual(15);
    for (const doc of legal) {
      expect(doc.review_status).toBe("draft_requires_review");
      expect(doc.version).toMatch(/draft/);
      expect(doc.body_markdown).toContain("DRAFT — REQUIRES LEGAL/INSURANCE APPROVAL");
      expect(doc.body_markdown.toLowerCase()).not.toContain("all liability is waived");
    }
  });

  it("states plainly in the disclosures that tips may be taxable and names no tax-free amount", () => {
    const disclosures = legal.find((d: { document_key: string }) => d.document_key === "donation_tip_contribution_disclosures");
    expect(disclosures.body_markdown).toContain("Tips may be taxable even if you do not receive a tax form");
    expect(disclosures.body_markdown).not.toMatch(/\$?599|\$?600/);
    expect(disclosures.body_markdown.toLowerCase()).not.toContain("tax free");
  });

  it("keeps demo data obviously fictional and never pre-screened", () => {
    const blob = JSON.stringify(demo);
    expect(blob).toContain("TEST");
    expect(blob).toMatch(/example\.invalid/);
    expect(blob).toMatch(/555-01\d\d/);
    for (const row of demo) {
      if (row.entity === "DriverProfile") {
        expect(row.data.eligibility_status).toBe("ineligible");
        expect(row.data.approval_tier).toBe("none");
      }
    }
    // No real named individual is seeded anywhere.
    expect(blob.toLowerCase()).not.toContain("sirrita");
  });

  it("leaves every partner detail the platform does not actually know blank", () => {
    const entry = readFileSync(join(seedDir, "entry.ts"), "utf8");
    for (const field of ["street_address", "operating_hours_text", "pickup_instructions", "inventory_notes", "public_description"]) {
      expect(entry).toMatch(new RegExp(`${field}:\\s*""`));
    }
    expect(entry).toMatch(/acknowledgement_approved:\s*false/);
  });
});
