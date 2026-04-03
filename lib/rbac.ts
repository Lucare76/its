import type { UserRole } from "@/lib/types";

export const routeRoleMap: Array<{ prefix: string; roles: UserRole[] }> = [
  { prefix: "/dashboard", roles: ["admin", "operator"] },
  { prefix: "/arrivals", roles: ["admin", "operator"] },
  { prefix: "/departures", roles: ["admin", "operator"] },
  { prefix: "/notifications", roles: ["admin", "operator"] },
  { prefix: "/analytics", roles: ["admin", "operator"] },
  { prefix: "/onboarding", roles: ["admin", "operator"] },
  { prefix: "/servizi", roles: ["admin", "operator"] },
  { prefix: "/services/new", roles: ["admin", "operator"] },
  { prefix: "/crm-agencies", roles: ["admin", "operator"] },
  { prefix: "/agency/new-booking", roles: ["admin", "agency"] },
  { prefix: "/agency", roles: ["admin", "agency"] },
  { prefix: "/agency/bookings", roles: ["admin", "agency"] },
  { prefix: "/dispatch", roles: ["admin", "operator"] },
  { prefix: "/bus-tours", roles: ["admin", "operator"] },
  { prefix: "/bus-network", roles: ["admin", "operator"] },
  { prefix: "/mario-planning", roles: ["admin", "operator"] },
  { prefix: "/rete-ischia", roles: ["admin", "operator"] },
  { prefix: "/planning", roles: ["admin", "operator"] },
  { prefix: "/arrivals-clock", roles: ["admin", "operator"] },
  { prefix: "/ops-summary", roles: ["admin", "operator"] },
  { prefix: "/report-center", roles: ["admin", "operator"] },
  { prefix: "/scheduler", roles: ["admin", "operator"] },
  { prefix: "/service-workflow", roles: ["admin", "operator"] },
  { prefix: "/excel-workspace", roles: ["admin", "operator"] },
  { prefix: "/excel-import", roles: ["admin", "operator"] },
  { prefix: "/ops-rules", roles: ["admin", "operator"] },
  { prefix: "/audit", roles: ["admin", "operator"] },
  { prefix: "/hotels", roles: ["admin", "operator"] },
  { prefix: "/driver", roles: ["admin", "driver"] },
  { prefix: "/fleet-ops", roles: ["admin", "operator", "driver"] },
  { prefix: "/mappa-live", roles: ["admin", "operator"] },
  { prefix: "/preventivo-ops", roles: ["admin", "operator"] },
  { prefix: "/map", roles: ["admin", "operator"] },
  { prefix: "/ingestion", roles: ["admin", "operator"] },
  { prefix: "/inbox", roles: ["admin", "operator"] },
  { prefix: "/pdf-imports", roles: ["admin"] },
  { prefix: "/pricing", roles: ["admin", "operator"] },
  { prefix: "/settings/users", roles: ["admin"] },
  { prefix: "/settings/whatsapp", roles: ["admin"] },
  { prefix: "/mappa-live", roles: ["admin", "operator"] }
];

export type AppCapability =
  | "dashboard:view"
  | "arrivals:view"
  | "departures:view"
  | "notifications:view"
  | "analytics:view"
  | "services:view"
  | "services:create"
  | "crm_agencies:view"
  | "dispatch:manage"
  | "bus_network:view"
  | "planning:manage"
  | "arrivals_clock:view"
  | "ops_summary:view"
  | "report_center:view"
  | "scheduler:view"
  | "service_workflow:view"
  | "excel_workspace:view"
  | "excel_import:view"
  | "ops_rules:view"
  | "statements:view"
  | "audit:view"
  | "inbox:manage"
  | "pdf_imports:manage"
  | "pdf_imports:debug"
  | "pricing:view"
  | "pricing:manage"
  | "agencies:manage"
  | "agency_bookings:self"
  | "agency_bookings:manage"
  | "driver:self"
  | "fleet_ops:view"
  | "quotes:view"
  | "users:manage"
  | "whatsapp:manage";

export type CapabilityOverrides = Partial<Record<AppCapability, boolean>>;

export const capabilityRoleMap: Record<AppCapability, UserRole[]> = {
  "dashboard:view": ["admin", "operator"],
  "arrivals:view": ["admin", "operator"],
  "departures:view": ["admin", "operator"],
  "notifications:view": ["admin", "operator"],
  "analytics:view": ["admin", "operator"],
  "services:view": ["admin", "operator"],
  "services:create": ["admin", "operator"],
  "crm_agencies:view": ["admin", "operator"],
  "dispatch:manage": ["admin", "operator"],
  "bus_network:view": ["admin", "operator"],
  "planning:manage": ["admin", "operator"],
  "arrivals_clock:view": ["admin", "operator"],
  "ops_summary:view": ["admin", "operator"],
  "report_center:view": ["admin", "operator"],
  "scheduler:view": ["admin", "operator"],
  "service_workflow:view": ["admin", "operator"],
  "excel_workspace:view": ["admin", "operator"],
  "excel_import:view": ["admin", "operator"],
  "ops_rules:view": ["admin", "operator"],
  "statements:view": ["admin", "operator"],
  "audit:view": ["admin", "operator"],
  "inbox:manage": ["admin", "operator"],
  "pdf_imports:manage": ["admin", "operator"],
  "pdf_imports:debug": ["admin"],
  "pricing:view": ["admin", "operator"],
  "pricing:manage": ["admin"],
  "agencies:manage": ["admin"],
  "agency_bookings:self": ["agency"],
  "agency_bookings:manage": ["admin"],
  "driver:self": ["driver", "admin"],
  "fleet_ops:view": ["admin", "operator", "driver"],
  "quotes:view": ["admin", "operator"],
  "users:manage": ["admin"],
  "whatsapp:manage": ["admin"]
};

export const routeCapabilityMap: Array<{ prefix: string; capability: AppCapability }> = [
  { prefix: "/settings/users", capability: "users:manage" },
  { prefix: "/settings/whatsapp", capability: "whatsapp:manage" },
  { prefix: "/dashboard", capability: "dashboard:view" },
  { prefix: "/arrivals", capability: "arrivals:view" },
  { prefix: "/departures", capability: "departures:view" },
  { prefix: "/notifications", capability: "notifications:view" },
  { prefix: "/services/new", capability: "services:create" },
  { prefix: "/crm-agencies", capability: "crm_agencies:view" },
  { prefix: "/agency/bookings", capability: "agency_bookings:self" },
  { prefix: "/agency/new-booking", capability: "agency_bookings:self" },
  { prefix: "/agency", capability: "agency_bookings:self" },
  { prefix: "/dispatch", capability: "dispatch:manage" },
  { prefix: "/bus-network", capability: "bus_network:view" },
  { prefix: "/mario-planning", capability: "planning:manage" },
  { prefix: "/rete-ischia", capability: "dispatch:manage" },
  { prefix: "/planning", capability: "planning:manage" },
  { prefix: "/arrivals-clock", capability: "arrivals_clock:view" },
  { prefix: "/ops-summary", capability: "ops_summary:view" },
  { prefix: "/report-center", capability: "report_center:view" },
  { prefix: "/scheduler", capability: "scheduler:view" },
  { prefix: "/service-workflow", capability: "service_workflow:view" },
  { prefix: "/excel-workspace", capability: "excel_workspace:view" },
  { prefix: "/excel-import", capability: "excel_import:view" },
  { prefix: "/ops-rules", capability: "ops_rules:view" },
  { prefix: "/audit", capability: "audit:view" },
  { prefix: "/driver", capability: "driver:self" },
  { prefix: "/fleet-ops", capability: "fleet_ops:view" },
  { prefix: "/preventivo-ops", capability: "quotes:view" },
  { prefix: "/inbox", capability: "inbox:manage" },
  { prefix: "/pdf-imports", capability: "pdf_imports:debug" },
  { prefix: "/pricing/margins", capability: "pricing:view" },
  { prefix: "/pricing", capability: "pricing:view" }
];

export function isProtectedPath(pathname: string): boolean {
  return routeRoleMap.some((item) => pathname.startsWith(item.prefix));
}

export function isAllowed(pathname: string, role: UserRole | null): boolean {
  return isAllowedWithOverrides(pathname, role);
}

export function isAllowedWithOverrides(pathname: string, role: UserRole | null, overrides?: CapabilityOverrides): boolean {
  const capabilityMatch = [...routeCapabilityMap]
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .find((item) => pathname.startsWith(item.prefix));
  if (capabilityMatch) {
    return hasCapability(role, capabilityMatch.capability, overrides);
  }

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

export function hasCapability(role: UserRole | null, capability: AppCapability, overrides?: CapabilityOverrides): boolean {
  if (!role) return false;
  if (overrides && capability in overrides) {
    return overrides[capability] === true;
  }
  return capabilityRoleMap[capability].includes(role);
}
