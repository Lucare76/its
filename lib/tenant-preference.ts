import { parseRole } from "@/lib/rbac";

export const ACTIVE_TENANT_COOKIE = "it_active_tenant";

type MembershipLike = {
  tenant_id: string | null;
  role?: string | null;
  suspended?: boolean | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeTenantId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function validMembershipRows<T extends MembershipLike>(memberships: T[] | null | undefined) {
  return (memberships ?? []).filter((item) => Boolean(item.tenant_id) && parseRole(item.role ?? undefined) !== null);
}

export function resolvePreferredMembership<T extends MembershipLike>(
  memberships: T[] | null | undefined,
  preferredTenantId?: string | null
): T | null {
  const rows = validMembershipRows(memberships);
  if (rows.length === 0) return null;

  const normalizedPreferredTenantId = normalizeTenantId(preferredTenantId);
  if (normalizedPreferredTenantId) {
    const preferredActive =
      rows.find((item) => item.tenant_id === normalizedPreferredTenantId && item.suspended !== true) ??
      rows.find((item) => item.tenant_id === normalizedPreferredTenantId) ??
      null;
    if (preferredActive) return preferredActive;
  }

  return rows.find((item) => item.suspended !== true) ?? rows[0] ?? null;
}

export function hasMembershipForTenant<T extends MembershipLike>(
  memberships: T[] | null | undefined,
  tenantId: string | null | undefined
) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (!normalizedTenantId) return false;
  return validMembershipRows(memberships).some((item) => item.tenant_id === normalizedTenantId);
}

export function getRequestedTenantFromRequest(request: {
  headers: Headers;
  cookies?: { get(name: string): { value: string } | undefined };
}) {
  const headerTenantId =
    normalizeTenantId(request.headers.get("x-tenant-id")) ??
    normalizeTenantId(request.headers.get("x-active-tenant-id"));
  const cookieTenantId = normalizeTenantId(request.cookies?.get(ACTIVE_TENANT_COOKIE)?.value);

  return {
    preferredTenantId: headerTenantId ?? cookieTenantId,
    strictTenantId: headerTenantId,
    cookieTenantId
  };
}
