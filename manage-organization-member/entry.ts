/**
 * Organization membership. An org admin may PROPOSE a scheduler; only a
 * platform admin may approve one, because a scheduler can request rides for
 * other people.
 */
import { fail, forbidden, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";
import { hasRole } from "../../shared/authz.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    if (!body) return fail("invalid_body", "Send a JSON object.", 400);

    const action = String(body.action ?? "");
    const organizationId = String(body.organization_id ?? "");
    const sr = ctx.base44.asServiceRole.entities;
    const isPlatformAdmin = hasRole(ctx.principal, "platform_admin");
    const isOrgAdmin = hasRole(ctx.principal, "org_admin") && ctx.principal.organizationIds.includes(organizationId);

    if (action === "propose") {
      if (!isOrgAdmin && !isPlatformAdmin) return forbidden("Only an organization administrator can propose a scheduler.");
      const email = String(body.user_email ?? "").trim().toLowerCase();
      const orgRole = body.org_role === "org_admin" ? "org_admin" : "scheduler";

      const profiles = await sr.UserProfile.filter({ email }, undefined, 1);
      const person = (profiles ?? [])[0];
      if (!person) {
        return fail("user_not_found", "We have no account for that email. Ask them to sign up first.", 404);
      }
      const existing = await sr.OrganizationMember.filter({ organization_id: organizationId, user_id: person.user_id }, undefined, 1);
      if ((existing ?? []).length > 0) {
        return ok({ member_id: existing[0].id, status: existing[0].status, message: "They are already on the list." });
      }

      const created = await sr.OrganizationMember.create({
        organization_id: organizationId,
        user_id: person.user_id,
        user_email: email,
        org_role: orgRole,
        status: "requested",
      });
      await audit(ctx, {
        event_type: "organization.member_proposed", action: "create",
        subject_entity: "OrganizationMember", subject_id: created.id,
        metadata: { organization_id: organizationId, org_role: orgRole },
      });
      return ok({
        member_id: created.id,
        status: "requested",
        message: "Proposed. A platform administrator has to approve them before they can request rides for anyone.",
      }, 201);
    }

    if (action === "approve" || action === "revoke") {
      if (!isPlatformAdmin) {
        return forbidden("Only a platform administrator can approve or revoke organization access.");
      }
      const memberId = String(body.member_id ?? "");
      const rows = await sr.OrganizationMember.filter({ id: memberId }, undefined, 1);
      const member = (rows ?? [])[0];
      if (!member) return notFound("That member does not exist.");

      const now = new Date().toISOString();
      const approved = action === "approve";

      await sr.OrganizationMember.update(memberId, {
        status: approved ? "approved" : "revoked",
        approved_by_email: approved ? ctx.principal.email : member.approved_by_email,
        approved_at: approved ? now : member.approved_at,
      });

      // Mirror the grant onto RoleAssignment, which is what authorization reads.
      const role = member.org_role === "org_admin" ? "org_admin" : "org_scheduler";
      const assignments = await sr.RoleAssignment.filter({
        user_id: member.user_id, role, organization_id: member.organization_id,
      }, undefined, 1);
      if (approved) {
        if ((assignments ?? []).length > 0) {
          await sr.RoleAssignment.update(assignments[0].id, {
            status: "approved", approved_by_email: ctx.principal.email, approved_at: now, revoked_at: "",
          });
        } else {
          await sr.RoleAssignment.create({
            user_id: member.user_id, user_email: member.user_email, role,
            organization_id: member.organization_id, status: "approved",
            approved_by_email: ctx.principal.email, approved_at: now,
          });
        }
      } else if ((assignments ?? []).length > 0) {
        await sr.RoleAssignment.update(assignments[0].id, {
          status: "revoked", revoked_at: now, revoked_reason_code: String(body.reason_code ?? "revoked_by_admin"),
        });
      }

      await audit(ctx, {
        event_type: "organization.member_decided", action: approved ? "approve" : "reject",
        subject_entity: "OrganizationMember", subject_id: memberId,
        from_state: member.status, to_state: approved ? "approved" : "revoked",
        metadata: { organization_id: member.organization_id, role },
      });

      return ok({ member_id: memberId, status: approved ? "approved" : "revoked", role });
    }

    return fail("invalid_action", "action must be propose, approve, or revoke.", 400);
  } catch (e) {
    console.error("manage_organization_member_failed", String(e));
    return serverError();
  }
}
