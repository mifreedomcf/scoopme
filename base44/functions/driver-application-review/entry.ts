/**
 * Authorized reviewer decision on a driver application.
 *
 * Approval requires every mandatory credential to be verified and unexpired.
 * There is no path where a driver's own action grants them eligibility.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, todayISO } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";
import { REQUIRED_ADULT_CREDENTIALS, REQUIRED_MINOR_CREDENTIALS } from "../../shared/matching.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();
    if (!hasRole(ctx.principal, "safety_staff") && !hasRole(ctx.principal, "platform_admin")) {
      return forbidden("Only safety staff can decide driver applications.");
    }

    const body = await readJson(req);
    const applicationId = String(body?.application_id ?? "");
    const decision = String(body?.decision ?? "");
    const reasonCategory = body?.decision_reason_category ? String(body.decision_reason_category) : "";
    const tier = String(body?.approval_tier ?? "adult_transport_approved");

    if (!["approve", "decline"].includes(decision)) return fail("invalid_decision", "decision must be approve or decline.", 400);

    const rows = await ctx.base44.asServiceRole.entities.DriverApplication.filter({ id: applicationId }, undefined, 1);
    const app = (rows ?? [])[0];
    if (!app) return notFound("That application does not exist.");

    // A reviewer may not decide their own application.
    if (app.user_id === ctx.principal.userId) {
      await audit(ctx, {
        event_type: "driver.review", action: "approve", outcome: "denied",
        subject_entity: "DriverApplication", subject_id: applicationId, reason_code: "self_review_blocked",
      });
      return forbidden("You cannot decide your own application.");
    }

    const profiles = await ctx.base44.asServiceRole.entities.DriverProfile.filter({ user_id: app.user_id }, undefined, 1);
    const profile = (profiles ?? [])[0];
    if (!profile) return notFound("No driver profile exists for that application.");

    const now = new Date().toISOString();

    if (decision === "decline") {
      await ctx.base44.asServiceRole.entities.DriverApplication.update(applicationId, {
        status: "declined", decision: "declined", decision_reason_category: reasonCategory,
        decision_by_email: ctx.principal.email, decision_at: now,
      });
      await ctx.base44.asServiceRole.entities.DriverProfile.update(profile.id, {
        approval_tier: "none", eligibility_status: "ineligible",
        eligibility_reason_code: "application_declined", eligibility_computed_at: now,
      });
      await audit(ctx, {
        event_type: "driver.review", action: "reject", subject_entity: "DriverApplication",
        subject_id: applicationId, reason_code: reasonCategory || "declined",
      });
      return ok({ application_id: applicationId, decision: "declined", appeal_available: true });
    }

    // Approval: every required credential must be verified and unexpired.
    const today = todayISO();
    const credentials = await ctx.base44.asServiceRole.entities.DriverCredential.filter({ driver_profile_id: profile.id });
    const byType = new Map((credentials ?? []).map((c: Record<string, string>) => [c.credential_type, c]));
    const required = tier === "minor_transport_approved"
      ? [...REQUIRED_ADULT_CREDENTIALS, ...REQUIRED_MINOR_CREDENTIALS]
      : REQUIRED_ADULT_CREDENTIALS;

    const blocking: string[] = [];
    for (const type of required) {
      const c = byType.get(type);
      if (!c || c.status !== "verified" || (c.expiration_date && c.expiration_date < today)) {
        blocking.push(type);
      }
    }
    if (blocking.length > 0) {
      await audit(ctx, {
        event_type: "driver.review", action: "approve", outcome: "denied",
        subject_entity: "DriverApplication", subject_id: applicationId,
        reason_code: "credentials_incomplete", metadata: { blocking: blocking.join(",") },
      });
      return fail("credentials_incomplete", `Cannot approve: these are missing, unverified, or expired — ${blocking.join(", ")}.`, 409);
    }

    await ctx.base44.asServiceRole.entities.DriverApplication.update(applicationId, {
      status: "approved", decision: "approved", decision_by_email: ctx.principal.email, decision_at: now,
    });
    await ctx.base44.asServiceRole.entities.DriverProfile.update(profile.id, {
      approval_tier: tier, eligibility_status: "eligible",
      eligibility_reason_code: "approved_credentials_current",
      eligibility_computed_at: now, approved_at: now,
    });
    await ctx.base44.asServiceRole.entities.RoleAssignment.create({
      user_id: app.user_id, user_email: app.applicant_email, role: "volunteer_driver",
      status: "approved", approved_by_email: ctx.principal.email, approved_at: now,
    });

    await audit(ctx, {
      event_type: "driver.review", action: "approve", subject_entity: "DriverApplication",
      subject_id: applicationId, to_state: tier,
    });

    return ok({ application_id: applicationId, decision: "approved", approval_tier: tier });
  } catch (e) {
    console.error("driver_application_review_failed", String(e));
    return serverError();
  }
}
