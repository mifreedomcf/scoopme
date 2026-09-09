import { describe, expect, it } from "vitest";
import { buildPrincipal, hasRole, isRideParty, isStaff, requireRole, viewerKindFor } from "@shared/authz";
import { isRateLimited } from "@shared/http";
import { safeEqual, verificationCode, secureToken } from "@shared/ids";

const rider = buildPrincipal({ id: "u-rider", email: "rider@example.invalid" }, [
  { role: "adult_rider", status: "approved" },
]);
const driver = buildPrincipal({ id: "u-driver", email: "driver@example.invalid" }, [
  { role: "volunteer_driver", status: "approved" },
]);
const pending = buildPrincipal({ id: "u-pending", email: "pending@example.invalid" }, [
  { role: "dispatcher", status: "requested" },
]);
const dispatcher = buildPrincipal({ id: "u-dispatch", email: "dispatch@example.invalid" }, [
  { role: "dispatcher", status: "approved" },
]);
const suspended = buildPrincipal({ id: "u-sus", email: "sus@example.invalid" }, [
  { role: "dispatcher", status: "approved" },
], true);

const ride = { rider_user_id: "u-rider", requested_by_user_id: "u-rider", organization_id: "org-1" };

describe("authorization", () => {
  it("ignores a role that has been requested but not approved", () => {
    expect(hasRole(pending, "dispatcher")).toBe(false);
    expect(requireRole(pending, ["dispatcher"]).code).toBe("forbidden");
    expect(requireRole(dispatcher, ["dispatcher"]).ok).toBe(true);
  });

  it("strips every role from a suspended account", () => {
    expect(hasRole(suspended, "dispatcher")).toBe(false);
    expect(isStaff(suspended)).toBe(false);
    expect(requireRole(suspended, ["dispatcher"]).code).toBe("account_suspended");
  });

  it("treats a Base44 admin as a platform admin and nothing else by implication", () => {
    const admin = buildPrincipal({ id: "u-admin", email: "admin@example.invalid", role: "admin" }, []);
    expect(hasRole(admin, "platform_admin")).toBe(true);
    expect(admin.roles).not.toContain("volunteer_driver");
  });

  it("only treats someone as a ride party when they are actually connected to it", () => {
    expect(isRideParty(rider, ride)).toBe(true);
    expect(isRideParty(driver, ride)).toBe(false);
  });

  it("never treats an unassigned driver as assigned", () => {
    expect(viewerKindFor(driver, ride, false)).toBe("unassigned_driver");
    expect(viewerKindFor(driver, ride, true)).toBe("assigned_driver");
    expect(viewerKindFor(rider, ride, false)).toBe("rider");
    expect(viewerKindFor(dispatcher, ride, false)).toBe("dispatcher");
  });

  it("gives a stranger the public view, which reveals nothing", () => {
    const stranger = buildPrincipal({ id: "u-x", email: "x@example.invalid" }, []);
    expect(viewerKindFor(stranger, ride, false)).toBe("public");
  });
});

describe("rate limiting and codes", () => {
  it("counts only events inside the window", () => {
    const now = new Date("2026-09-08T12:00:00Z");
    const today = ["2026-09-08T11:00:00Z", "2026-09-08T10:00:00Z", "2026-09-08T09:00:00Z"];
    expect(isRateLimited({ eventTimestamps: today, windowMs: 86_400_000, limit: 3, now })).toBe(true);
    expect(isRateLimited({ eventTimestamps: today, windowMs: 86_400_000, limit: 5, now })).toBe(false);
    const old = ["2026-09-01T11:00:00Z", "2026-08-30T10:00:00Z"];
    expect(isRateLimited({ eventTimestamps: old, windowMs: 86_400_000, limit: 1, now })).toBe(false);
  });

  it("produces unambiguous, non-repeating verification codes and unguessable tokens", () => {
    const codes = new Set(Array.from({ length: 500 }, () => verificationCode(6)));
    expect(codes.size).toBeGreaterThan(495);
    for (const code of codes) expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(secureToken(16)).toHaveLength(32);
    expect(new Set(Array.from({ length: 200 }, () => secureToken(16))).size).toBe(200);
  });

  it("compares codes without leaking length-independent equality", () => {
    expect(safeEqual("K7Q2MP", "K7Q2MP")).toBe(true);
    expect(safeEqual("K7Q2MP", "K7Q2MQ")).toBe(false);
    expect(safeEqual("K7Q2MP", "K7Q2M")).toBe(false);
  });
});
