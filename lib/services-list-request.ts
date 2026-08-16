// Pure, framework-free builder for POST /api/services/list requests, mirroring
// lib/supabase/tenant-data-request.ts (Sprint Performance 13). Kept separate so
// query-shape/request-key logic can be unit tested without React or Supabase.
// Sprint Performance 14A — Lista servizi pagination.

import type { ServiceStatus, ServiceType } from "@/lib/types";

export type ServicesListFilters = {
  status: ServiceStatus | "all";
  serviceType: ServiceType | "all";
  vessel: string;
  zone: string;
  driverUserId: string;
  search: string;
  source: "all" | "pdf" | "agency" | "manual";
  reviewed: "all" | "yes" | "no";
  agency: string;
  quality: "all" | "low";
};

export type ServicesListRequestOptions = {
  tenantId: string;
  filters: ServicesListFilters;
  page: number;
  pageSize: number;
};

export type ServicesListRequestBody = {
  tenant_id: string;
  status: ServiceStatus[];
  service_type?: ServiceType;
  ship: string;
  zone: string;
  driver_user_id?: string;
  search: string;
  source: "all" | "pdf" | "agency" | "manual";
  reviewed: "all" | "yes" | "no";
  agency: string;
  quality: "all" | "low";
  page: number;
  page_size: number;
};

export type ServicesListRequest = {
  body: ServicesListRequestBody;
  requestKey: string;
};

/**
 * Key identifying only the FILTER portion of a request (no page/pageSize).
 * Used by the client to detect "the user changed a filter" and reset to page 1.
 */
export function buildServicesListFilterKey(filters: ServicesListFilters): string {
  return [
    filters.status,
    filters.serviceType,
    filters.vessel,
    filters.zone,
    filters.driverUserId,
    filters.search.trim().toLowerCase(),
    filters.source,
    filters.reviewed,
    filters.agency,
    filters.quality
  ].join("|");
}

/**
 * Builds the POST body + a stable request key for a given filters+page
 * combination. Two calls with equivalent options produce the same requestKey,
 * so the caller can tell "same request, in flight again" apart from "this is
 * superseded by a newer request" (stale-response guard).
 */
export function buildServicesListRequest(options: ServicesListRequestOptions): ServicesListRequest {
  const { tenantId, filters, page, pageSize } = options;
  const search = filters.search.trim();

  const body: ServicesListRequestBody = {
    tenant_id: tenantId,
    status: filters.status === "all" ? [] : [filters.status],
    service_type: filters.serviceType === "all" ? undefined : filters.serviceType,
    ship: filters.vessel === "all" ? "" : filters.vessel,
    zone: filters.zone === "all" ? "" : filters.zone,
    driver_user_id: filters.driverUserId === "all" ? undefined : filters.driverUserId,
    search,
    source: filters.source,
    reviewed: filters.reviewed,
    agency: filters.agency,
    quality: filters.quality,
    page,
    page_size: pageSize
  };

  const requestKey = [
    tenantId,
    buildServicesListFilterKey(filters),
    `page:${page}`,
    `size:${pageSize}`
  ].join("::");

  return { body, requestKey };
}
