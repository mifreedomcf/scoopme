/**
 * Authorization. Pure module.
 *
 * Base44's built-in user roles are 'user' and 'admin'. Everything finer-grained
 * lives in RoleAssignment rows that only staff can create. This module turns
 * those rows into a decision. Entity RLS is the second line of defence; this is
 * the first.
 */
import { Role, STAFF_ROLES } from "./constants.ts";

export interface RoleAssignmentRow {
  role: Role;
  status: string;
  organization_id?: string;
}

export interface Principal {
  userId: string;
  email: string;
  /** Base44 platform role. */
  platformRole: "user" | "admin";
  roles: Role[];
  organizationIds: string[];
  suspended: boolean;
}

export function buildPrincipal(
  user: { id: string; email: string; role?: string },
  assignments: RoleAssignmentRow[],
  suspended = false,
): Principal {
  const approved = assignments.filter((a) => a.status === "approved");
  return {
    userId: user.id,
    email: user.email,
    platformRole: user.role === "admin" ? "admin" : "user",
    roles: approved.map((a) => a.role),
    organizationIds: approved.map((a) => a.organization_id).filter((x): x is string => Boolean(x)),
    suspended,
  };
}

export function hasRole(principal: Principal, role: Role): boolean {
  if (principal.suspended) return false;
  // A Base44 admin is always a platform admin, but no other role is implied.
  if (role === "platform_admin" && principal.platformRole === "admin") return true;
  return principal.roles.includes(role);
}

export function isStaff(principal: Principal): boolean {
  if (principal.suspended) return false;
  if (principal.platformRole === "admin") return true;
  return STAFF_ROLES.some((r) => principal.roles.includes(r));
}

export function requireRole(principal: Principal, roles: Role[]): { ok: boolean; code: string; message: string } {
  if (principal.suspended) {
    return { ok: false, code: "account_suspended", message: "This account is suspended." };
  }
  if (roles.some((r) => hasRole(principal, r))) {
    return { ok: true, code: "ok", message: "Authorized." };
  }
  return { ok: false, code: "forbidden", message: "You do not have access to this action." };
}

export interface RideOwnership {
  rider_user_id?: string;
  requested_by_user_id?: string;
  organization_id?: string;
}

/** Is this principal a party to this ride (rider, requester, or the sponsoring org)? */
export function isRideParty(principal: Principal, ride: RideOwnership): boolean {
  if (principal.suspended) return false;
  if (ride.rider_user_id && ride.rider_user_id === principal.userId) return true;
  if (ride.requested_by_user_id && ride.requested_by_user_id === principal.userId) return true;
  if (
    ride.organization_id &&
    principal.organizationIds.includes(ride.organization_id) &&
    (hasRole(principal, "org_scheduler") || hasRole(principal, "org_admin"))
  ) {
    return true;
  }
  return false;
}

/**
 * The viewer kind used for data minimization. Ordered most-privileged first so
 * a person holding several roles gets the correct view, and so a driver who is
 * not assigned to this ride can never be treated as assigned.
 */
export function viewerKindFor(
  principal: Principal,
  ride: RideOwnership,
  isAssignedDriver: boolean,
):
  | "rider"
  | "guardian"
  | "org_scheduler"
  | "unassigned_driver"
  | "assigned_driver"
  | "dispatcher"
  | "safety_staff"
  | "platform_admin"
  | "public" {
  if (hasRole(principal, "platform_admin")) return "platform_admin";
  if (hasRole(principal, "safety_staff")) return "safety_staff";
  if (hasRole(principal, "dispatcher")) return "dispatcher";
  if (isAssignedDriver) return "assigned_driver";
  if (ride.rider_user_id === principal.userId) return "rider";
  if (hasRole(principal, "guardian") && ride.requested_by_user_id === principal.userId) return "guardian";
  if (isRideParty(principal, ride)) return "org_scheduler";
  if (hasRole(principal, "volunteer_driver")) return "unassigned_driver";
  return "public";
}
