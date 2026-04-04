import type { UserRole } from "@/lib/types";

export const routeRoleMap: Array<{ prefix: string; roles: UserRole[] }> = [
  { prefix: "/dashboard", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/arrivals", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/departures", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/notifications", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/analytics", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/onboarding", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/servizi", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/services/new", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/crm-agencies", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/agency/new-booking", roles: ["admin", "agency", "supervisor"] },
  { prefix: "/agency", roles: ["admin", "agency", "supervisor"] },
  { prefix: "/agency/bookings", roles: ["admin", "agency", "supervisor"] },
  { prefix: "/dispatch", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/bus-tours", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/bus-network", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/mario-planning", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/rete-ischia", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/planning", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/arrivals-clock", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/ops-summary", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/report-center", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/scheduler", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/service-workflow", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/excel-workspace", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/excel-import", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/ops-rules", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/audit", roles: ["admin", "supervisor"] },
  { prefix: "/hotels", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/driver", roles: ["admin", "driver", "supervisor"] },
  { prefix: "/fleet-ops", roles: ["admin", "operator", "driver", "supervisor"] },
  { prefix: "/mappa-live", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/preventivo-ops", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/map", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/ingestion", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/inbox", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/pricing", roles: ["admin", "operator", "supervisor"] },
  { prefix: "/settings/users", roles: ["admin", "supervisor"] },
  { prefix: "/settings/whatsapp", roles: ["admin", "supervisor"] },
  { prefix: "/settings/system", roles: ["admin", "supervisor"] },
  { prefix: "/settings/email-preview", roles: ["admin", "supervisor"] },
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
  "dashboard:view": ["admin", "operator", "supervisor"],
  "arrivals:view": ["admin", "operator", "supervisor"],
  "departures:view": ["admin", "operator", "supervisor"],
  "notifications:view": ["admin", "operator", "supervisor"],
  "analytics:view": ["admin", "operator", "supervisor"],
  "services:view": ["admin", "operator", "supervisor"],
  "services:create": ["admin", "operator", "supervisor"],
  "crm_agencies:view": ["admin", "operator", "supervisor"],
  "dispatch:manage": ["admin", "operator", "supervisor"],
  "bus_network:view": ["admin", "operator", "supervisor"],
  "planning:manage": ["admin", "operator", "supervisor"],
  "arrivals_clock:view": ["admin", "operator", "supervisor"],
  "ops_summary:view": ["admin", "operator", "supervisor"],
  "report_center:view": ["admin", "operator", "supervisor"],
  "scheduler:view": ["admin", "operator", "supervisor"],
  "service_workflow:view": ["admin", "operator", "supervisor"],
  "excel_workspace:view": ["admin", "operator", "supervisor"],
  "excel_import:view": ["admin", "operator", "supervisor"],
  "ops_rules:view": ["admin", "operator", "supervisor"],
  "statements:view": ["admin", "operator", "supervisor"],
  "audit:view": ["admin", "supervisor"],
  "inbox:manage": ["admin", "operator", "supervisor"],
  "pricing:view": ["admin", "operator", "supervisor"],
  "pricing:manage": ["admin", "supervisor"],
  "agencies:manage": ["admin", "supervisor"],
  "agency_bookings:self": ["agency"],
  "agency_bookings:manage": ["admin", "supervisor"],
  "driver:self": ["driver", "admin", "supervisor"],
  "fleet_ops:view": ["admin", "operator", "driver", "supervisor"],
  "quotes:view": ["admin", "operator", "supervisor"],
  "users:manage": ["admin", "supervisor"],
  "whatsapp:manage": ["admin", "supervisor"]
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
  if (normalized === "admin" || normalized === "operator" || normalized === "driver" || normalized === "agency" || normalized === "supervisor") {
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
