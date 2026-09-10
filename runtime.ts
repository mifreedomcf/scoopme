/**
 * The only shared module that touches the Base44 SDK. Everything above it is
 * pure and unit-tested; this is the thin seam where I/O happens.
 */
import { createClientFromRequest } from "npm:@base44/sdk@^0.8.48";
import { buildPrincipal, Principal } from "./authz.ts";
import { resolveConfig } from "./flags.ts";
import type { GateRecord } from "./flags.ts";
import type { SystemConfigShape } from "./constants.ts";
import { redactForLog } from "./minimize.ts";

export interface Ctx {
  base44: ReturnType<typeof createClientFromRequest>;
  user: { id: string; email: string; role?: string } | null;
  principal: Principal | null;
}

/** Build the request context: authenticated client, user, and resolved roles. */
export async function buildContext(req: Request): Promise<Ctx> {
  const base44 = createClientFromRequest(req);
  let user: { id: string; email: string; role?: string } | null = null;
  try {
    user = (await base44.auth.me()) as never;
  } catch {
    user = null;
  }
  if (!user) return { base44, user: null, principal: null };

  const assignments = await base44.asServiceRole.entities.RoleAssignment.filter({
    user_id: user.id,
    status: "approved",
  });
  const profiles = await base44.asServiceRole.entities.UserProfile.filter({ user_id: user.id }, undefined, 1);
  const suspended = Boolean(profiles?.[0]?.suspended);

  return { base44, user, principal: buildPrincipal(user, assignments ?? [], suspended) };
}

/** Load the live configuration, falling back to the restrictive defaults. */
export async function loadConfig(ctx: Ctx): Promise<SystemConfigShape> {
  try {
    const rows = await ctx.base44.asServiceRole.entities.SystemConfig.filter({ config_key: "active" }, undefined, 1);
    return resolveConfig(rows?.[0] ?? null);
  } catch {
    return resolveConfig(null);
  }
}

export async function loadGates(ctx: Ctx): Promise<GateRecord[]> {
  try {
    return ((await ctx.base44.asServiceRole.entities.LaunchGate.list(undefined, 500)) ?? []) as GateRecord[];
  } catch {
    return [];
  }
}

export interface AuditInput {
  event_type: string;
  action: string;
  outcome?: "allowed" | "denied" | "error";
  subject_entity?: string;
  subject_id?: string;
  reason_code?: string;
  from_state?: string;
  to_state?: string;
  justification?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append one audit row. Written with the service role because AuditLog denies
 * client writes entirely. Payload is redacted before it is stored.
 */
export async function audit(ctx: Ctx, input: AuditInput): Promise<void> {
  try {
    await ctx.base44.asServiceRole.entities.AuditLog.create({
      event_type: input.event_type,
      action: input.action,
      outcome: input.outcome ?? "allowed",
      actor_user_id: ctx.principal?.userId ?? "",
      actor_email: ctx.principal?.email ?? "",
      actor_role: ctx.principal?.roles?.join(",") ?? (ctx.user ? "user" : "anonymous"),
      subject_entity: input.subject_entity,
      subject_id: input.subject_id,
      reason_code: input.reason_code,
      from_state: input.from_state,
      to_state: input.to_state,
      justification: input.justification,
      metadata: input.metadata ? redactForLog(input.metadata) : undefined,
      occurred_at: new Date().toISOString(),
    });
  } catch {
    // Never let an audit failure leak details to the caller, and never swallow
    // it silently either — it goes to the function log.
    console.error("audit_write_failed", { event_type: input.event_type });
  }
}

/** Is there an active retention hold covering this record? */
export async function hasActiveHold(ctx: Ctx, entity: string, id: string): Promise<boolean> {
  try {
    const holds = await ctx.base44.asServiceRole.entities.DataRetentionHold.filter({
      scope_entity: entity,
      is_active: true,
    });
    return (holds ?? []).some((h: { scope_id?: string }) => !h.scope_id || h.scope_id === id);
  } catch {
    // Fail closed: if we cannot tell, treat the record as held.
    return true;
  }
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
