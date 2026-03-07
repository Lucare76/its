import type { UserRole } from "@/lib/types";

export const ROLE_COOKIE = "it_role";

export const routeRoleMap: Array<{ prefix: string; roles: UserRole[] }> = [
  { prefix: "/dashboard", roles: ["admin", "operator"] },
  { prefix: "/analytics", roles: ["admin", "operator"] },
  { prefix: "/onboarding", roles: ["admin", "operator"] },
  { prefix: "/services/new", roles: ["admin", "operator", "agency"] },
  { prefix: "/agency", roles: ["admin", "agency"] },
  { prefix: "/agency/bookings", roles: ["admin", "agency"] },
  { prefix: "/dispatch", roles: ["admin", "operator"] },
  { prefix: "/bus-tours", roles: ["admin", "operator"] },
  { prefix: "/planning", roles: ["admin", "operator"] },
  { prefix: "/hotels", roles: ["admin", "operator"] },
  { prefix: "/driver", roles: ["admin", "driver"] },
  { prefix: "/map", roles: ["admin", "operator", "agency"] },
  { prefix: "/ingestion", roles: ["admin", "operator"] },
  { prefix: "/inbox", roles: ["admin", "operator"] },
  { prefix: "/settings/whatsapp", roles: ["admin"] }
];

export function isProtectedPath(pathname: string): boolean {
  return routeRoleMap.some((item) => pathname.startsWith(item.prefix));
}

export function isAllowed(pathname: string, role: UserRole | null): boolean {
  const match = routeRoleMap.find((item) => pathname.startsWith(item.prefix));
  if (!match) return true;
  if (!role) return false;
  return match.roles.includes(role);
}

export function parseRole(raw: string | undefined): UserRole | null {
  if (!raw) return null;
  if (raw === "admin" || raw === "operator" || raw === "driver" || raw === "agency") return raw;
  return null;
}
