/**
 * A guardian maintains a child's profile and the adults allowed to collect them.
 *
 * There is no child account and no child login. Nothing is collected directly
 * from a child. For anyone under 13 this design is deliberate and load-bearing:
 * COPPA review and verifiable parental consent would be prerequisites for any
 * child-facing feature, and none exists.
 *
 * Unreachable while minor_rides_enabled is false.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext, loadConfig, todayISO } from "../../shared/runtime.ts";
import { MICHIGAN_DEFAULT_POLICY, requiredRestraint } from "../../shared/restraints.ts";
import { checkAuthority, type GuardianAuthority } from "../../shared/consent.ts";
import { validateUpload } from "../../shared/uploads.ts";

/** Fields we accept. Anything else a client sends is dropped. */
const CHILD_FIELDS = [
  "first_name", "last_initial", "date_of_birth", "height_inches",
  "guardian_states_exceeds_rear_facing_limits", "mobility_needs",
  "language_preference", "notes_for_dispatch",
];

/** Things we refuse to store about a child, even if offered. */
const REFUSED_FIELDS = [
  "school", "school_name", "diagnosis", "medical_details", "medications",
  "iep", "custody_details", "case_number", "ssn", "social_security_number",
  "immigration_status", "weight_pounds", "home_address",
];

function ageYears(dob: string, on: string): number {
  const birth = new Date(`${dob}T00:00:00Z`);
  const when = new Date(`${on}T00:00:00Z`);
  let age = when.getUTCFullYear() - birth.getUTCFullYear();
  const m = when.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && when.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const config = await loadConfig(ctx);
    if (!config.minor_rides_enabled) {
      return fail(
        "minor_rides_disabled",
        "Rides for under-18s are not available. This part of the service is switched off.",
        409,
      );
    }

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    for (const banned of REFUSED_FIELDS) {
      if (body[banned] !== undefined) {
        return fail("field_not_collected", "We do not collect that about a child.", 400, [
          { field: banned, code: "field_not_collected", message: "This platform does not record that." },
        ]);
      }
    }

    const sr = ctx.base44.asServiceRole.entities;
    const today = todayISO();
    const now = new Date().toISOString();
    const action = String(body.action ?? "save_child");

    // ---- Add or update an adult permitted to collect the child ----
    if (action === "add_authorized_adult" || action === "deactivate_authorized_adult") {
      const dependentId = String(body.dependent_profile_id ?? "");
      const relRows = await sr.GuardianRelationship.filter({
        guardian_user_id: ctx.principal.userId, dependent_profile_id: dependentId,
      }, undefined, 1);
      const authority = ((relRows ?? [])[0] ?? null) as GuardianAuthority | null;
      const check = checkAuthority(authority, dependentId, ctx.principal.userId, today);
      if (!check.ok) return forbidden(check.message);

      if (action === "deactivate_authorized_adult") {
        const adultId = String(body.authorized_adult_id ?? "");
        const rows = await sr.AuthorizedAdult.filter({ id: adultId }, undefined, 1);
        const adult = (rows ?? [])[0];
        if (!adult || adult.dependent_profile_id !== dependentId) return notFound("That person is not on the list.");
        await sr.AuthorizedAdult.update(adultId, { active: false, deactivated_at: now });
        await audit(ctx, {
          event_type: "minor.authorized_adult_removed", action: "update",
          subject_entity: "AuthorizedAdult", subject_id: adultId,
          metadata: { dependent_profile_id: dependentId },
        });
        return ok({ authorized_adult_id: adultId, active: false });
      }

      const errors: { field: string; code: string; message: string }[] = [];
      for (const f of ["name", "relationship", "phone"]) {
        if (!body[f]) errors.push({ field: f, code: "required", message: "This is needed so a driver can check who they are." });
      }
      let scanStatus = "not_applicable";
      if (body.photo_reference) {
        if (/^https?:\/\//i.test(String(body.photo_reference))) {
          errors.push({ field: "photo_reference", code: "public_url_rejected", message: "A photo has to be a private upload, not a link." });
        } else {
          const verdict = validateUpload({
            filename: String(body.filename ?? ""),
            contentType: String(body.content_type ?? ""),
            sizeBytes: Number(body.size_bytes ?? 0),
            purpose: "profile_photo",
          });
          if (!verdict.ok) errors.push({ field: "photo_reference", code: verdict.code, message: verdict.message });
          else scanStatus = "pending";
        }
      }
      if (errors.length > 0) return fail("validation_failed", "A few details are needed.", 400, errors);

      const created = await sr.AuthorizedAdult.create({
        dependent_profile_id: dependentId,
        added_by_guardian_user_id: ctx.principal.userId,
        name: String(body.name),
        relationship: String(body.relationship),
        phone: String(body.phone),
        role: ["pickup", "dropoff", "both"].includes(String(body.role)) ? String(body.role) : "both",
        photo_reference: body.photo_reference ? String(body.photo_reference) : undefined,
        photo_scan_status: scanStatus,
        active: true,
      });
      await audit(ctx, {
        event_type: "minor.authorized_adult_added", action: "create",
        subject_entity: "AuthorizedAdult", subject_id: created.id,
        metadata: { dependent_profile_id: dependentId, role: created.role },
      });
      return ok({
        authorized_adult_id: created.id,
        note: "This person will need the child's code at handoff. The code changes every trip and is never given to the driver.",
      }, 201);
    }

    // ---- Create or update the child's profile ----
    const patch: Record<string, unknown> = {};
    for (const f of CHILD_FIELDS) if (body[f] !== undefined) patch[f] = body[f];

    const dob = String(patch.date_of_birth ?? "");
    if (!dob) return fail("missing_fields", "We need the child's date of birth to choose the right car seat.", 400);
    const age = ageYears(dob, today);
    if (age < 0 || age > 17) {
      return fail(
        "not_a_minor",
        age > 17
          ? "This person is 18 or over. They can hold their own account and book their own rides."
          : "That date of birth is not valid.",
        400,
      );
    }

    const dependentId = body.dependent_profile_id ? String(body.dependent_profile_id) : "";
    let id: string;

    if (dependentId) {
      const relRows = await sr.GuardianRelationship.filter({
        guardian_user_id: ctx.principal.userId, dependent_profile_id: dependentId,
      }, undefined, 1);
      const check = checkAuthority(((relRows ?? [])[0] ?? null) as GuardianAuthority | null, dependentId, ctx.principal.userId, today);
      if (!check.ok) return forbidden(check.message);
      await sr.DependentProfile.update(dependentId, patch);
      id = dependentId;
    } else {
      const created = await sr.DependentProfile.create({
        managing_guardian_user_id: ctx.principal.userId,
        assistance_level: "hand_to_hand",
        active: true,
        ...patch,
      });
      id = created.id;
      // The authority record starts UNVERIFIED. Creating a child profile does
      // not make anyone that child's guardian.
      await sr.GuardianRelationship.create({
        guardian_user_id: ctx.principal.userId,
        guardian_email: ctx.principal.email,
        dependent_profile_id: id,
        authority_type: ["parent", "legal_guardian", "court_appointed_custodian", "documented_delegated_authority"]
          .includes(String(body.authority_type)) ? String(body.authority_type) : "parent",
        relationship_label: body.relationship_label ? String(body.relationship_label) : "",
        status: "unverified",
      });
    }

    const requirement = requiredRestraint(
      {
        age_years: age,
        height_inches: patch.height_inches !== undefined ? Number(patch.height_inches) : undefined,
        guardian_states_exceeds_rear_facing_limits:
          patch.guardian_states_exceeds_rear_facing_limits as boolean | undefined,
      },
      MICHIGAN_DEFAULT_POLICY,
    );

    await audit(ctx, {
      event_type: dependentId ? "minor.profile_updated" : "minor.profile_created",
      action: dependentId ? "update" : "create",
      subject_entity: "DependentProfile", subject_id: id,
      metadata: { required_restraint: requirement.required, age_band: age < 2 ? "under_2" : age < 5 ? "2_to_4" : age < 8 ? "5_to_7" : "8_plus" },
    });

    return ok({
      dependent_profile_id: id,
      required_restraint: requirement.required,
      rear_seat_required: requirement.rear_seat_required,
      restraint_reason: requirement.reason,
      needs_more_information: requirement.needs_more_information,
      restraint_policy_reviewed: requirement.policy_reviewed,
      next_steps: [
        "A coordinator has to verify that you are this child's parent or legal guardian before anything can be booked.",
        "Add the adults who are allowed to drop off and collect them.",
        "Each trip needs your signature on the current consent wording.",
      ],
      notice: requirement.policy_reviewed
        ? undefined
        : "DRAFT — REQUIRES LEGAL REVIEW. The car seat rules in this system have not yet been checked against Michigan law by an attorney.",
    }, dependentId ? 200 : 201);
  } catch (e) {
    console.error("manage_dependent_profile_failed", String(e));
    return serverError();
  }
}
