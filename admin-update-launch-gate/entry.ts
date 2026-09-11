/**
 * Update one compliance launch-gate row.
 *
 * Marking a gate complete requires an evidence link and a named reviewer, and
 * the reviewer may not be the person marking it. History is immutable: the
 * change is recorded in AuditLog, which nobody can edit.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

const EDITABLE = ["status", "owner_email", "evidence_url", "reviewer_email", "approved_date", "expires_date", "notes"];

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "platform_admin")) return forbidden("Only platform administrators can update launch gates.");

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);
    const gateKey = String(body.gate_key ?? "");
    const changes = (body.changes ?? {}) as Record<string, unknown>;

    const rows = await ctx.base44.asServiceRole.entities.LaunchGate.filter({ gate_key: gateKey }, undefined, 1);
    const gate = (rows ?? [])[0];
    if (!gate) return notFound("That launch gate does not exist.");

    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (EDITABLE.includes(k)) patch[k] = v;
    }

    if (patch.status === "complete") {
      const evidence = String(patch.evidence_url ?? gate.evidence_url ?? "");
      const reviewer = String(patch.reviewer_email ?? gate.reviewer_email ?? "");
      const errors: { field: string; code: string; message: string }[] = [];
      if (!evidence) errors.push({ field: "evidence_url", code: "required", message: "Link the signed document, binder, or determination before marking this complete." });
      if (!reviewer) errors.push({ field: "reviewer_email", code: "required", message: "Name the reviewer who approved this." });
      if (reviewer && reviewer.toLowerCase() === ctx.principal.email.toLowerCase()) {
        errors.push({ field: "reviewer_email", code: "separation_of_duties", message: "The reviewer must be someone other than the person marking the gate complete." });
      }
      if (errors.length > 0) {
        await audit(ctx, {
          event_type: "gate.update", action: "update", outcome: "denied",
          subject_entity: "LaunchGate", subject_id: gate.id, reason_code: "incomplete_evidence",
        });
        return fail("validation_failed", "This gate cannot be marked complete yet.", 400, errors);
      }
      patch.approved_date = patch.approved_date ?? todayISO();
    }

    await ctx.base44.asServiceRole.entities.LaunchGate.update(gate.id, patch);
    await audit(ctx, {
      event_type: "gate.update", action: "update", subject_entity: "LaunchGate", subject_id: gate.id,
      from_state: gate.status, to_state: String(patch.status ?? gate.status),
      metadata: { gate_key: gateKey, fields: Object.keys(patch).join(",") },
    });

    return ok({ gate_key: gateKey, status: patch.status ?? gate.status });
  } catch (e) {
    console.error("admin_update_launch_gate_failed", String(e));
    return serverError();
  }
}
