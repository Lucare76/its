import { parseRole } from "@/lib/rbac";

export const PRIMARY_TENANT_ID = "d200b89a-64c7-4f8d-a430-95a33b83047a";

type MembershipLike = {
  tenant_id: string | null;
  role?: string | null;
  suspended?: boolean | null;
};

export function resolvePreferredMembership<T extends MembershipLike>(memberships: T[] | null | undefined): T | null {
  const rows = (memberships ?? []).filter((item) => Boolean(item.tenant_id) && parseRole(item.role ?? undefined) !== null);
  if (rows.length === 0) return null;

  const preferredActive =
    rows.find((item) => item.tenant_id === PRIMARY_TENANT_ID && item.suspended !== true) ??
    rows.find((item) => item.tenant_id === PRIMARY_TENANT_ID) ??
    null;
  if (preferredActive) return preferredActive;

  return rows.find((item) => item.suspended !== true) ?? rows[0] ?? null;
}

export function hasPreferredTenantMembership<T extends MembershipLike>(memberships: T[] | null | undefined) {
  return (memberships ?? []).some((item) => item.tenant_id === PRIMARY_TENANT_ID);
}
