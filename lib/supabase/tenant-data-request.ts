// Pure, framework-free builder for /api/ops/tenant-data requests. Kept separate
// from use-tenant-operational-data.ts so the query-param/request-key logic can
// be unit tested without React or Supabase. Sprint Performance 13.
//
// Two independent knobs:
//  - `datasets`: which tables to query at all (opt-in — omit the whole option
//    to keep today's "fetch everything" behavior).
//  - `serviceScope`: how to narrow the `services` query itself (and, on the
//    server, cascades to limit assignments/statusEvents to the returned
//    service ids). Omit to keep today's "fetchAllServices" behavior.
//
// Omitting BOTH options entirely reproduces the exact pre-Sprint-13 request
// (same query string shape), so unmigrated consumers are unaffected.

export type TenantDataset =
  | "services"
  | "assignments"
  | "statusEvents"
  | "hotels"
  | "memberships"
  | "busLotConfigs"
  | "inboundEmails";

export type ServiceScope =
  | { mode: "date"; date: string }
  | { mode: "range"; from: string; to: string }
  | { mode: "ids"; ids: string[] };

export type TenantOperationalDataOptions = {
  /** Legacy flag, kept for backward compatibility with existing call-sites. */
  includeInboundEmails?: boolean;
  /** Opt-in dataset selection. Omit to request every dataset (legacy behavior). */
  datasets?: Partial<Record<TenantDataset, boolean>>;
  /** Narrows the services query. Omit to keep the full-tenant-history fetch. */
  serviceScope?: ServiceScope;
};

export type TenantDataRequest = {
  searchParams: URLSearchParams;
  /** Deterministic key identifying this exact scope+dataset combination. */
  requestKey: string;
};

const ALL_DATASETS: TenantDataset[] = [
  "services",
  "assignments",
  "statusEvents",
  "hotels",
  "memberships",
  "busLotConfigs",
  "inboundEmails"
];

function resolveDatasets(options?: TenantOperationalDataOptions): TenantDataset[] {
  const includeInboundEmails = options?.includeInboundEmails === true;
  if (!options?.datasets) {
    return ALL_DATASETS.filter((name) => name !== "inboundEmails" || includeInboundEmails);
  }
  const explicit = options.datasets;
  return ALL_DATASETS.filter((name) => {
    if (name === "inboundEmails") return explicit.inboundEmails === true || includeInboundEmails;
    return explicit[name] === true;
  });
}

function scopeKey(scope: ServiceScope): string {
  if (scope.mode === "date") return `date:${scope.date}`;
  if (scope.mode === "range") return `range:${scope.from}:${scope.to}`;
  return `ids:${[...scope.ids].sort().join(",")}`;
}

/**
 * Builds the query string + a stable request key for a given options object.
 * Two calls with equivalent options (including ids in a different order)
 * produce the same requestKey, so the hook can tell "same scope, refresh
 * again" apart from "different scope, this is a new request" — see
 * use-tenant-operational-data.ts's stale-response guard.
 */
export function buildTenantDataRequest(options?: TenantOperationalDataOptions): TenantDataRequest {
  const params = new URLSearchParams();
  const includeInboundEmails = options?.includeInboundEmails === true;

  // Pure legacy path (no datasets, no serviceScope): reproduce the exact
  // pre-Sprint-13 query string so the server takes its untouched legacy
  // branch. This is what keeps every non-migrated consumer working as-is.
  if (!options?.datasets && !options?.serviceScope) {
    params.set("include_inbound_emails", includeInboundEmails ? "true" : "false");
    return { searchParams: params, requestKey: `legacy:${includeInboundEmails}` };
  }

  const datasets = resolveDatasets(options);
  params.set("datasets", datasets.join(","));

  let scopePart = "legacy";
  if (options?.serviceScope) {
    const scope = options.serviceScope;
    params.set("service_scope", scope.mode);
    if (scope.mode === "date") {
      params.set("date", scope.date);
    } else if (scope.mode === "range") {
      params.set("from", scope.from);
      params.set("to", scope.to);
    } else {
      params.set("ids", [...scope.ids].sort().join(","));
    }
    scopePart = scopeKey(scope);
  } else {
    params.set("service_scope", "legacy");
  }

  return {
    searchParams: params,
    requestKey: `${datasets.join(",")}|${scopePart}`
  };
}
