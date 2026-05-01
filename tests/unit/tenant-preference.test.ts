import { describe, expect, it } from "vitest";
import { ACTIVE_TENANT_COOKIE, getRequestedTenantFromRequest, hasMembershipForTenant, resolvePreferredMembership } from "@/lib/tenant-preference";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

describe("resolvePreferredMembership", () => {
  const memberships = [
    { tenant_id: tenantA, role: "operator", suspended: false },
    { tenant_id: tenantB, role: "admin", suspended: false }
  ];

  it("uses the requested tenant when it is available", () => {
    const resolved = resolvePreferredMembership(memberships, tenantB);
    expect(resolved?.tenant_id).toBe(tenantB);
    expect(resolved?.role).toBe("admin");
  });

  it("falls back to the first active membership when no preferred tenant is provided", () => {
    const resolved = resolvePreferredMembership(memberships);
    expect(resolved?.tenant_id).toBe(tenantA);
  });

  it("ignores an invalid preferred tenant id", () => {
    const resolved = resolvePreferredMembership(memberships, "not-a-uuid");
    expect(resolved?.tenant_id).toBe(tenantA);
  });
});

describe("hasMembershipForTenant", () => {
  const memberships = [
    { tenant_id: tenantA, role: "operator", suspended: false }
  ];

  it("returns true only when the tenant is present", () => {
    expect(hasMembershipForTenant(memberships, tenantA)).toBe(true);
    expect(hasMembershipForTenant(memberships, tenantB)).toBe(false);
  });
});

describe("getRequestedTenantFromRequest", () => {
  it("prefers the explicit tenant header over the cookie", () => {
    const requestLike = {
      headers: new Headers({ "x-tenant-id": tenantB }),
      cookies: {
        get(name: string) {
          if (name === ACTIVE_TENANT_COOKIE) return { value: tenantA };
          return undefined;
        }
      }
    };

    const resolved = getRequestedTenantFromRequest(requestLike);
    expect(resolved.preferredTenantId).toBe(tenantB);
    expect(resolved.strictTenantId).toBe(tenantB);
    expect(resolved.cookieTenantId).toBe(tenantA);
  });
});
