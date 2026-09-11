/**
 * Scheduled deletion and anonymization.
 *
 * Off until an administrator turns it on, after the retention schedule has
 * actually been reviewed. Once on, it fails closed in every direction: an
 * unreadable hold table, a missing rule, a missing date, or a protected entity
 * all mean "keep". Nothing here can delete an audit record, an incident, or a
 * consent.
 */
import { ok, serverError } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import {
  anonymizationPatch, decideSweep, NEVER_SWEPT, rulesFromConfig,
  type HoldSnapshot, type RetentionRule,
} from "../../shared/retention.ts";

const BATCH = 300;

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    const sr = ctx.base44.asServiceRole.entities;
    const config = await loadConfig(ctx);
    const today = todayISO();

    if (config.retention_sweep_enabled !== true) {
      return ok({
        ran: false,
        code: "sweep_disabled",
        message: "The retention sweep is off. Turn it on once the retention schedule has been reviewed.",
      });
    }

    const rules: RetentionRule[] = rulesFromConfig(
      config.retention_overrides as Record<string, number> | undefined,
    );

    // Read the holds once. If we cannot, we delete nothing at all.
    let holds: HoldSnapshot[] | null = null;
    try {
      holds = ((await sr.DataRetentionHold.filter({ is_active: true }, undefined, 500)) ?? []) as HoldSnapshot[];
    } catch {
      holds = null;
    }
    if (holds === null) {
      await audit(ctx, {
        event_type: "retention.sweep", action: "delete", outcome: "error",
        reason_code: "holds_unreadable",
      });
      return ok({ ran: false, code: "holds_unreadable", message: "Could not read the hold table, so nothing was removed." });
    }

    const summary: Record<string, { deleted: number; anonymized: number; kept: number }> = {};

    for (const rule of rules) {
      if (NEVER_SWEPT.includes(rule.entity) || rule.action === "keep") continue;
      summary[rule.entity] = { deleted: 0, anonymized: 0, kept: 0 };

      let rows: Record<string, unknown>[] = [];
      try {
        rows = ((await sr[rule.entity].list(rule.anchor_field, BATCH)) ?? []) as Record<string, unknown>[];
      } catch {
        continue;
      }

      for (const row of rows) {
        // Already anonymized rows are left alone, so the sweep is idempotent.
        if (rule.action === "anonymize" && row.anonymized_at) {
          summary[rule.entity].kept += 1;
          continue;
        }

        const decision = decideSweep(
          {
            entity: rule.entity,
            id: String(row.id),
            anchor_value: row[rule.anchor_field] ? String(row[rule.anchor_field]) : undefined,
          },
          rules, holds, today,
        );

        if (decision.action === "keep") {
          summary[rule.entity].kept += 1;
          continue;
        }

        if (decision.action === "anonymize") {
          await sr[rule.entity].update(String(row.id), anonymizationPatch(decision.anonymize_fields ?? []));
          summary[rule.entity].anonymized += 1;
          continue;
        }

        // Soft delete: the row is marked and stops being served. A hard purge
        // is a separate, deliberate operation, not something a job does.
        await sr[rule.entity].update(String(row.id), { deleted_at: new Date().toISOString() });
        summary[rule.entity].deleted += 1;
      }
    }

    await audit(ctx, {
      event_type: "retention.sweep", action: "delete",
      metadata: {
        swept_on: today,
        active_holds: holds.length,
        ...Object.fromEntries(
          Object.entries(summary).map(([k, v]) => [k, `${v.deleted}d/${v.anonymized}a/${v.kept}k`]),
        ),
      },
    });

    return ok({ ran: true, swept_on: today, active_holds: holds.length, summary });
  } catch (e) {
    console.error("retention_sweep_failed", String(e));
    return serverError();
  }
}
