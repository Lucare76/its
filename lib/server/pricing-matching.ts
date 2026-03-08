type AdminClient = any;

type MatchInput = {
  tenantId: string;
  inboundEmailId: string;
  serviceId: string;
  sourceText: string;
  serviceType: "transfer" | "bus_tour";
  direction: "arrival" | "departure";
  date: string;
  time: string;
  pax: number;
};

function normalize(value?: string | null) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value?: string | null) {
  const normalized = normalize(value);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length >= 3);
}

function scoreContains(haystack: string, needle: string) {
  if (!needle) return 0;
  if (haystack === needle) return 100;
  if (haystack.includes(needle)) return Math.max(60, Math.min(95, needle.length + 40));
  return 0;
}

function scoreTokenOverlap(sourceTokens: string[], candidateTokens: string[]) {
  if (sourceTokens.length === 0 || candidateTokens.length === 0) return 0;
  const sourceSet = new Set(sourceTokens);
  let hit = 0;
  for (const token of candidateTokens) {
    if (sourceSet.has(token)) hit += 1;
  }
  return Math.round((hit / candidateTokens.length) * 100);
}

export async function tryMatchAndApplyPricing(admin: AdminClient, input: MatchInput) {
  try {
    const normalizedSource = normalize(input.sourceText);
    const sourceTokens = tokenize(normalizedSource);
    const portHints = ["ischia porto", "forio", "casamicciola", "procida", "napoli", "pozzuoli", "porto"];

    const [{ data: agencies }, { data: aliases }, { data: routes }] = await Promise.all([
      admin.from("agencies").select("id, name, active").eq("tenant_id", input.tenantId).eq("active", true).limit(500),
      admin.from("agency_aliases").select("agency_id, alias").eq("tenant_id", input.tenantId).limit(1000),
      admin.from("routes").select("id, name, origin_label, destination_label, active").eq("tenant_id", input.tenantId).eq("active", true).limit(500)
    ]);

    const activeAgencies = (agencies ?? []) as Array<{ id: string; name: string; active: boolean }>;
    const activeRoutes = (routes ?? []) as Array<{ id: string; name: string; origin_label: string; destination_label: string; active: boolean }>;
    const agencyAliases = (aliases ?? []) as Array<{ agency_id: string; alias: string }>;

    let agencyMatch: { id: string; confidence: number } | null = null;
    for (const agency of activeAgencies) {
      const candidates = [
        normalize(agency.name),
        ...agencyAliases.filter((row) => row.agency_id === agency.id).map((row) => normalize(row.alias))
      ].filter(Boolean);
      let best = 0;
      for (const candidate of candidates) {
        const byContains = scoreContains(normalizedSource, candidate);
        const byTokens = scoreTokenOverlap(sourceTokens, tokenize(candidate));
        best = Math.max(best, byContains, byTokens);
      }
      if (best > (agencyMatch?.confidence ?? 0)) agencyMatch = { id: agency.id, confidence: best };
    }

    let routeMatch: { id: string; confidence: number } | null = null;
    for (const route of activeRoutes) {
      const routeName = normalize(route.name);
      const origin = normalize(route.origin_label);
      const destination = normalize(route.destination_label);
      const byName = scoreContains(normalizedSource, routeName);
      const byNameTokens = scoreTokenOverlap(sourceTokens, tokenize(routeName));
      const byOrigin = scoreTokenOverlap(sourceTokens, tokenize(origin));
      const byDestination = scoreTokenOverlap(sourceTokens, tokenize(destination));
      const byPoints = origin && destination && normalizedSource.includes(origin) && normalizedSource.includes(destination) ? 85 : 0;
      const byPortHints = portHints.some((hint) => normalizedSource.includes(hint)) ? 10 : 0;
      const score = Math.max(byName, byNameTokens, Math.round((byOrigin + byDestination) / 2), byPoints) + byPortHints;
      if (score > (routeMatch?.confidence ?? 0)) routeMatch = { id: route.id, confidence: score };
    }

    const serviceDate = input.date;
    const { data: priceLists } = await admin
      .from("price_lists")
      .select("id, currency, is_default, valid_from, valid_to, active")
      .eq("tenant_id", input.tenantId)
      .eq("active", true)
      .lte("valid_from", serviceDate)
      .or(`valid_to.is.null,valid_to.gte.${serviceDate}`)
      .order("is_default", { ascending: false })
      .order("valid_from", { ascending: false })
      .limit(20);

    const selectedPriceList = (priceLists ?? [])[0] as
      | { id: string; currency: string; is_default: boolean; valid_from: string; valid_to: string | null; active: boolean }
      | undefined;

    let selectedRule:
      | {
          id: string;
          route_id: string;
          agency_id: string | null;
          service_type: "transfer" | "bus_tour" | null;
          direction: "arrival" | "departure" | null;
          pax_min: number;
          pax_max: number | null;
          rule_kind: "fixed" | "per_pax";
          internal_cost_cents: number;
          public_price_cents: number;
          agency_price_cents: number | null;
          priority: number;
        }
      | null = null;

    if (selectedPriceList?.id && routeMatch?.id) {
      const { data: rules } = await admin
        .from("pricing_rules")
        .select("id, route_id, agency_id, service_type, direction, pax_min, pax_max, rule_kind, internal_cost_cents, public_price_cents, agency_price_cents, priority")
        .eq("tenant_id", input.tenantId)
        .eq("active", true)
        .eq("price_list_id", selectedPriceList.id)
        .eq("route_id", routeMatch.id)
        .order("priority", { ascending: true })
        .limit(200);

      const candidates = (rules ?? []) as Array<{
        id: string;
        route_id: string;
        agency_id: string | null;
        service_type: "transfer" | "bus_tour" | null;
        direction: "arrival" | "departure" | null;
        pax_min: number;
        pax_max: number | null;
        rule_kind: "fixed" | "per_pax";
        internal_cost_cents: number;
        public_price_cents: number;
        agency_price_cents: number | null;
        priority: number;
      }>;

      const filtered = candidates.filter((rule) => {
        const agencyOk = rule.agency_id === null || (agencyMatch?.id && rule.agency_id === agencyMatch.id);
        const typeOk = rule.service_type === null || rule.service_type === input.serviceType;
        const directionOk = rule.direction === null || rule.direction === input.direction;
        const paxOk = input.pax >= rule.pax_min && (rule.pax_max === null || input.pax <= rule.pax_max);
        return Boolean(agencyOk && typeOk && directionOk && paxOk);
      });

      filtered.sort((a, b) => {
        const aSpecific = a.agency_id ? 1 : 0;
        const bSpecific = b.agency_id ? 1 : 0;
        if (aSpecific !== bSpecific) return bSpecific - aSpecific;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.pax_min - b.pax_min;
      });

      selectedRule = filtered[0] ?? null;
    }

    const matchConfidence = Math.min(100, Math.max(agencyMatch?.confidence ?? 0, routeMatch?.confidence ?? 0));
    const matchStatus = selectedRule ? "matched" : "needs_review";
    const sourceType = normalizedSource.includes("pdf") ? "pdf_attachment" : "email_body";

    const importPayload = {
      tenant_id: input.tenantId,
      inbound_email_id: input.inboundEmailId,
      service_id: input.serviceId,
      source_type: sourceType,
      source_reference: "inbound-email-mvp",
      raw_payload: { source_text_excerpt: input.sourceText.slice(0, 3000) },
      extracted_json: {
        service_type: input.serviceType,
        direction: input.direction,
        date: input.date,
        time: input.time,
        pax: input.pax
      },
      normalized_agency_name: agencyMatch?.id ? activeAgencies.find((item) => item.id === agencyMatch.id)?.name ?? null : null,
      normalized_route_name: routeMatch?.id ? activeRoutes.find((item) => item.id === routeMatch.id)?.name ?? null : null,
      service_date: input.date,
      service_time: input.time,
      pax: input.pax,
      agency_id: agencyMatch?.id ?? null,
      route_id: routeMatch?.id ?? null,
      pricing_rule_id: selectedRule?.id ?? null,
      match_status: matchStatus,
      match_confidence: matchConfidence || null,
      match_notes: selectedRule ? "Auto match rule" : "No pricing rule matched"
    };

    const { data: importRow } = await admin.from("inbound_booking_imports").insert(importPayload).select("id").single();
    const importId = importRow?.id ?? null;

    if (!selectedRule) {
      await admin
        .from("services")
        .update({
          agency_id: agencyMatch?.id ?? null,
          route_id: routeMatch?.id ?? null,
          import_id: importId,
          pricing_apply_mode: "fallback",
          pricing_confidence: matchConfidence || null,
          pricing_applied_at: new Date().toISOString()
        })
        .eq("id", input.serviceId)
        .eq("tenant_id", input.tenantId);
      return;
    }

    const multiplier = selectedRule.rule_kind === "per_pax" ? Math.max(1, input.pax) : 1;
    const internalCost = selectedRule.internal_cost_cents * multiplier;
    const publicPrice = selectedRule.public_price_cents * multiplier;
    const agencyPrice = selectedRule.agency_price_cents === null ? null : selectedRule.agency_price_cents * multiplier;
    const finalPrice = agencyPrice ?? publicPrice;
    const margin = finalPrice - internalCost;
    const currency = selectedPriceList?.currency ?? "EUR";

    await admin.from("service_pricing").insert({
      tenant_id: input.tenantId,
      service_id: input.serviceId,
      price_list_id: selectedPriceList?.id ?? null,
      pricing_rule_id: selectedRule.id,
      agency_id: agencyMatch?.id ?? null,
      route_id: routeMatch?.id ?? null,
      currency,
      internal_cost_cents: internalCost,
      public_price_cents: publicPrice,
      agency_price_cents: agencyPrice,
      final_price_cents: finalPrice,
      apply_mode: "auto_rule",
      confidence: matchConfidence || null,
      snapshot_json: {
        rule_kind: selectedRule.rule_kind,
        multiplier,
        matched_agency_id: agencyMatch?.id ?? null,
        matched_route_id: routeMatch?.id ?? null
      },
      created_at: new Date().toISOString()
    });

    await admin
      .from("services")
      .update({
        agency_id: agencyMatch?.id ?? null,
        route_id: routeMatch?.id ?? null,
        import_id: importId,
        applied_price_list_id: selectedPriceList?.id ?? null,
        applied_pricing_rule_id: selectedRule.id,
        pricing_currency: currency,
        internal_cost_cents: internalCost,
        public_price_cents: publicPrice,
        agency_price_cents: agencyPrice,
        final_price_cents: finalPrice,
        margin_cents: margin,
        pricing_apply_mode: "auto_rule",
        pricing_confidence: matchConfidence || null,
        pricing_applied_at: new Date().toISOString()
      })
      .eq("id", input.serviceId)
      .eq("tenant_id", input.tenantId);
  } catch (error) {
    console.error("Pricing match/apply failed", error);
  }
}
