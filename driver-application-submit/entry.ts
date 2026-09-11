/**
 * Submit a volunteer driver application for review.
 *
 * A driver can never approve themselves: this function only moves the
 * application to a review queue and records what is still missing.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig } from "../../shared/runtime.ts";

const REQUIRED_ACKS = [
  "policy_zero_tolerance_accepted",
  "policy_nondiscrimination_accepted",
  "training_safe_driving_ack",
  "training_boundaries_ack",
  "training_mandated_reporting_ack",
  "training_incident_response_ack",
  "training_rider_assistance_ack",
  "training_privacy_ack",
];

function ageOn(dob: string, when: Date): number {
  const birth = new Date(dob);
  let age = when.getFullYear() - birth.getFullYear();
  const m = when.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && when.getDate() < birth.getDate())) age -= 1;
  return age;
}

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    const applicationId = String(body?.application_id ?? "");
    if (!applicationId) return fail("missing_fields", "application_id is required.", 400);

    const rows = await ctx.base44.asServiceRole.entities.DriverApplication.filter({ id: applicationId }, undefined, 1);
    const app = (rows ?? [])[0];
    if (!app || app.user_id !== ctx.principal.userId) return notFound("That application does not exist.");
    if (!["draft", "documents_pending"].includes(app.status)) {
      return fail("already_submitted", "This application has already been submitted.", 409);
    }

    const config = await loadConfig(ctx);
    const errors: { field: string; code: string; message: string }[] = [];
    const now = new Date();

    for (const field of ["legal_first_name", "legal_last_name", "date_of_birth", "phone", "license_issuing_state", "license_expiration"]) {
      if (!app[field]) errors.push({ field, code: "required", message: "This is needed before we can review your application." });
    }
    for (const ack of REQUIRED_ACKS) {
      if (!app[ack]) errors.push({ field: ack, code: "acknowledgement_required", message: "Read and accept this to continue." });
    }
    if (app.applying_for_minor_transport && !app.training_minor_handoff_ack) {
      errors.push({ field: "training_minor_handoff_ack", code: "acknowledgement_required", message: "Minor transport requires the handoff training acknowledgement." });
    }

    // Age gates are enforced here, against the current configured minimums.
    if (app.date_of_birth) {
      const age = ageOn(app.date_of_birth, now);
      if (age < Number(config.minimum_driver_age)) {
        errors.push({ field: "date_of_birth", code: "below_minimum_age", message: `Volunteer drivers must be at least ${config.minimum_driver_age}.` });
      }
      if (app.applying_for_minor_transport && age < Number(config.minimum_minor_transport_driver_age)) {
        errors.push({ field: "date_of_birth", code: "below_minor_transport_age", message: `Drivers transporting minors must be at least ${config.minimum_minor_transport_driver_age}.` });
      }
    }
    if (app.license_expiration && app.license_expiration < now.toISOString().slice(0, 10)) {
      errors.push({ field: "license_expiration", code: "expired", message: "Your licence has expired." });
    }

    if (errors.length > 0) {
      return fail("validation_failed", "A few things are still needed.", 400, errors);
    }

    await ctx.base44.asServiceRole.entities.DriverApplication.update(applicationId, {
      status: "checks_pending",
      submitted_at: now.toISOString(),
      decision: "pending",
    });

    // Background checks run in mock_pending_review until a vendor is configured.
    // The mock NEVER produces a passing result.
    const checkTypes = [
      "mvr_check", "criminal_background_check", "sex_offender_registry_check",
      ...(app.applying_for_minor_transport ? ["fingerprinting", "child_abuse_neglect_registry"] : []),
    ];
    const profileRows = await ctx.base44.asServiceRole.entities.DriverProfile.filter({ user_id: app.user_id }, undefined, 1);
    let profile = (profileRows ?? [])[0];
    if (!profile) {
      profile = await ctx.base44.asServiceRole.entities.DriverProfile.create({
        user_id: app.user_id,
        application_id: applicationId,
        display_name: `${app.legal_first_name} ${String(app.legal_last_name).charAt(0)}.`,
        approval_tier: "none",
        eligibility_status: "ineligible",
        eligibility_reason_code: "application_under_review",
        eligibility_computed_at: now.toISOString(),
      });
    }
    for (const type of checkTypes) {
      const existing = await ctx.base44.asServiceRole.entities.DriverCredential.filter({
        driver_profile_id: profile.id, credential_type: type,
      });
      if ((existing ?? []).length === 0) {
        await ctx.base44.asServiceRole.entities.DriverCredential.create({
          driver_profile_id: profile.id,
          credential_type: type,
          required_for: ["fingerprinting", "child_abuse_neglect_registry"].includes(type) ? "minor_transport" : "adult_transport",
          status: config.background_check_provider_mode === "live" ? "pending_vendor" : "not_started",
          vendor_name: config.background_check_provider_mode === "live" ? "configured_vendor" : "",
          decision_reason_category: config.background_check_provider_mode === "live" ? "" : "no_vendor_configured",
        });
      }
    }

    await audit(ctx, {
      event_type: "driver.application_submitted", action: "update",
      subject_entity: "DriverApplication", subject_id: applicationId, to_state: "checks_pending",
    });

    return ok({
      application_id: applicationId,
      status: "checks_pending",
      background_check_mode: config.background_check_provider_mode,
      message:
        config.background_check_provider_mode === "live"
          ? "Thanks. Your checks are running and a coordinator will follow up."
          : "Thanks. Your application is saved. Background checks cannot run until the pilot's screening vendor is set up, so approval is on hold until then.",
    });
  } catch (e) {
    console.error("driver_application_submit_failed", String(e));
    return serverError();
  }
}
