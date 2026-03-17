import type { UserRole } from "@/lib/types";

export const routeRoleMap: Array<{ prefix: string; roles: UserRole[] }> = [
  { prefix: "/dashboard", roles: ["admin", "operator"] },
  { prefix: "/analytics", roles: ["admin", "operator"] },
  { prefix: "/onboarding", roles: ["admin", "operator"] },
  { prefix: "/services/new", roles: ["admin", "operator"] },
  { prefix: "/agency/new-booking", roles: ["admin", "agency"] },
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
  { prefix: "/pdf-imports", roles: ["admin", "operator"] },
  { prefix: "/pricing", roles: ["admin", "operator"] },
  { prefix: "/settings/whatsapp", roles: ["admin"] }
];

export type AppCapability =
  | "dashboard:view"
  | "analytics:view"
  | "dispatch:manage"
  | "planning:manage"
  | "inbox:manage"
  | "pdf_imports:manage"
  | "pdf_imports:debug"
  | "pricing:view"
  | "pricing:manage"
  | "agencies:manage"
  | "agency_bookings:self"
  | "agency_bookings:manage"
  | "driver:self"
  | "whatsapp:manage";

export const capabilityRoleMap: Record<AppCapability, UserRole[]> = {
  "dashboard:view": ["admin", "operator"],
  "analytics:view": ["admin", "operator"],
  "dispatch:manage": ["admin", "operator"],
  "planning:manage": ["admin", "operator"],
  "inbox:manage": ["admin", "operator"],
  "pdf_imports:manage": ["admin", "operator"],
  "pdf_imports:debug": ["admin"],
  "pricing:view": ["admin", "operator"],
  "pricing:manage": ["admin"],
  "agencies:manage": ["admin"],
  "agency_bookings:self": ["agency"],
  "agency_bookings:manage": ["admin"],
  "driver:self": ["driver", "admin"],
  "whatsapp:manage": ["admin"]
};

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
  const normalized = raw.trim().toLowerCase();
  if (normalized === "admin" || normalized === "operator" || normalized === "driver" || normalized === "agency") {
    return normalized;
  }
  return null;
}

export function hasCapability(role: UserRole | null, capability: AppCapability): boolean {
  if (!role) return false;
  return capabilityRoleMap[capability].includes(role);
}
