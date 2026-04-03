type AdminClient = any;

type MatchInput = {
  tenantId: string;
  inboundEmailId: string;
  serviceId: string;
  senderEmail?: string | null;
  sourceText: string;
  serviceType: "transfer" | "bus_tour";
  direction: "arrival" | "departure";
  date: string;
  time: string;
  pax: number;
  bookingKind?: "transfer_port_hotel" | "transfer_airport_hotel" | "transfer_train_hotel" | "bus_city_hotel" | "excursion" | null;
  serviceVariant?: "train_station_hotel" | "ferry_naples_transfer" | "auto_ischia_hotel" | null;
};

type MatchQuality = "certain" | "partial" | "review";

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

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
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

function inferVehicleType(sourceText: string) {
  const text = normalize(sourceText);
  if (!text) return null;
  if (/\b(bus|pullman|coach)\b/.test(text)) return "BUS";
  if (/\b(van|minivan|vito|van8|van 8)\b/.test(text)) return "VAN";
  if (/\b(car|auto|taxi|sedan)\b/.test(text)) return "CAR";
  return null;
}

function deriveMatchQuality(hasRule: boolean, agencyScore: number, routeScore: number, forcedReview: boolean): MatchQuality {
  if (!hasRule || forcedReview) return "review";
  if (agencyScore >= 80 && routeScore >= 80) return "certain";
  if (agencyScore >= 55 || routeScore >= 70) return "partial";
  return "review";
}

function emailDomain(value?: string | null) {
  const normalized = (value ?? "").trim().toLowerCase();
  const parts = normalized.split("@");
  return parts.length === 2 ? parts[1] : "";
}

function routeIntentBoost(
  normalizedSource: string,
  route: { name: string; origin_label: string; destination_label: string },
  bookingKind?: MatchInput["bookingKind"],
  serviceVariant?: MatchInput["serviceVariant"]
) {
  const routeText = [route.name, route.origin_label, route.destination_label].map(normalize).join(" ");
  let boost = 0;

  if (bookingKind === "transfer_train_hotel" || /(stazione|treno|italo|trenitalia)/i.test(normalizedSource)) {
    if (/(stazione|treno|centrale)/i.test(routeText) && /(hotel|ischia|verde)/i.test(routeText)) boost = Math.max(boost, 25);
  }

  if (serviceVariant === "train_station_hotel") {
    if (/(stazione|treno|centrale)/i.test(routeText) && /(hotel|ischia|verde)/i.test(routeText)) boost = Math.max(boost, 35);
  }

  if (bookingKind === "transfer_port_hotel" || /(porto|traghetto|aliscafo|napoli)/i.test(normalizedSource)) {
    if (/(porto|napoli|molo|terminal)/i.test(routeText) && /(hotel|ischia|verde)/i.test(routeText)) boost = Math.max(boost, 25);
  }

  if (serviceVariant === "ferry_naples_transfer") {
    if (/(porto|napoli|molo|massa)/i.test(routeText) && /(hotel|ischia|villa)/i.test(routeText)) boost = Math.max(boost, 35);
  }

  if (serviceVariant === "auto_ischia_hotel") {
    if (/(ischia|porto)/i.test(routeText) && /(hotel|villa|resort)/i.test(routeText)) boost = Math.max(boost, 30);
  }

  if (bookingKind === "transfer_airport_hotel" || /(aeroporto|airport|capodichino)/i.test(normalizedSource)) {
    if (/(aeroporto|airport|capodichino)/i.test(routeText) && /(hotel|ischia|verde)/i.test(routeText)) boost = Math.max(boost, 25);
  }

  if (bookingKind === "bus_city_hotel" || /(bus|pullman|coach)/i.test(normalizedSource)) {
    if (/(bus|pullman|coach|city)/i.test(routeText)) boost = Math.max(boost, 20);
  }

  return boost;
}

export async function tryMatchAndApplyPricing(admin: AdminClient, input: MatchInput) {
  try {
    const normalizedSource = normalize(input.sourceText);
    const sourceTokens = tokenize(normalizedSource);
    const portHints = ["ischia porto", "forio", "casamicciola", "procida", "napoli", "pozzuoli", "porto"];

    const [{ data: agencies }, { data: aliases }, { data: routes }] = await Promise.all([
      admin.from("agencies").select("*").eq("tenant_id", input.tenantId).eq("active", true).limit(500),
      admin.from("agency_aliases").select("agency_id, alias").eq("tenant_id", input.tenantId).limit(1000),
      admin.from("routes").select("id, name, origin_label, destination_label, active").eq("tenant_id", input.tenantId).eq("active", true).limit(500)
    ]);

    const activeAgencies = (agencies ?? []) as Array<{
      id: string;
      name: string;
      active: boolean;
      contact_email?: string | null;
      booking_email?: string | null;
      contact_emails?: unknown;
      booking_emails?: unknown;
      sender_domains?: unknown;
    }>;
    const activeRoutes = (routes ?? []) as Array<{ id: string; name: string; origin_label: string; destination_label: string; active: boolean }>;
    const agencyAliases = (aliases ?? []) as Array<{ agency_id: string; alias: string }>;
    const normalizedSenderEmail = normalize(input.senderEmail);
    const senderDomain = emailDomain(input.senderEmail);

    let agencyMatch: { id: string; confidence: number; reason: string } | null = null;
    for (const agency of activeAgencies) {
      const agencyContactEmails = Array.isArray(agency.contact_emails) ? agency.contact_emails.map((item) => String(item).toLowerCase()) : [];
      const agencyBookingEmails = Array.isArray(agency.booking_emails) ? agency.booking_emails.map((item) => String(item).toLowerCase()) : [];
      const agencyDomains = Array.isArray(agency.sender_domains) ? agency.sender_domains.map((item) => String(item).toLowerCase()) : [];
      const exactEmails = uniqueStrings([
        ...(agency.contact_email ? [String(agency.contact_email).toLowerCase()] : []),
        ...(agency.booking_email ? [String(agency.booking_email).toLowerCase()] : []),
        ...agencyContactEmails,
        ...agencyBookingEmails
      ]);
      const candidates = [
        { value: normalize(agency.name), reason: "nome agenzia" },
        ...agencyAliases
          .filter((row) => row.agency_id === agency.id)
          .map((row) => ({ value: normalize(row.alias), reason: "alias agenzia" }))
      ].filter((item) => item.value);
      let best = 0;
      let bestReason = "nome agenzia";
      if (normalizedSenderEmail && exactEmails.some((email) => normalize(email) === normalizedSenderEmail)) {
        best = Math.max(best, 100);
        bestReason = "email esatta";
      }
      if (senderDomain && agencyDomains.includes(senderDomain)) {
        if (92 > best) {
          best = 92;
          bestReason = "dominio mittente";
        }
      }
      for (const candidate of candidates) {
        const byContains = scoreContains(normalizedSource, candidate.value);
        const byTokens = scoreTokenOverlap(sourceTokens, tokenize(candidate.value));
        if (byContains > best) {
          best = byContains;
          bestReason = candidate.reason;
        }
        if (byTokens > best) {
          best = byTokens;
          bestReason = `${candidate.reason} (token overlap)`;
        }
      }
      if (best > (agencyMatch?.confidence ?? 0)) agencyMatch = { id: agency.id, confidence: best, reason: bestReason };
    }

    let routeMatch: { id: string; confidence: number; reason: string } | null = null;
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
      const byIntent = routeIntentBoost(normalizedSource, route, input.bookingKind, input.serviceVariant);
      let score = 0;
      let reason = "nome tratta";
      if (byName > score) {
        score = byName;
        reason = "nome tratta";
      }
      if (byNameTokens > score) {
        score = byNameTokens;
        reason = "token nome tratta";
      }
      const byEndpoints = Math.round((byOrigin + byDestination) / 2);
      if (byEndpoints > score) {
        score = byEndpoints;
        reason = "origine/destinazione";
      }
      if (byPoints > score) {
        score = byPoints;
        reason = "origine e destinazione complete";
      }
      score += byPortHints + byIntent;
      if (byIntent > 0) reason = `${reason} + intento servizio`;
      if (score > (routeMatch?.confidence ?? 0)) routeMatch = { id: route.id, confidence: score, reason };
    }

    const serviceDate = input.date;
    const serviceTime = (input.time || "00:00").slice(0, 5);
    const vehicleTypeHint = inferVehicleType(input.sourceText);
    const { data: priceLists } = await admin
      .from("price_lists")
      .select("id, currency, is_default, valid_from, valid_to, active, agency_id")
      .eq("tenant_id", input.tenantId)
      .eq("active", true)
      .lte("valid_from", serviceDate)
      .or(`valid_to.is.null,valid_to.gte.${serviceDate}`)
      .limit(20);

    const sortedPriceLists = ((priceLists ?? []) as Array<{
      id: string;
      currency: string;
      is_default: boolean;
      valid_from: string;
      valid_to: string | null;
      active: boolean;
      agency_id: string | null;
    }>).sort((a, b) => {
      const aAgencyScore = agencyMatch?.id && a.agency_id === agencyMatch.id ? 2 : a.agency_id === null ? 1 : 0;
      const bAgencyScore = agencyMatch?.id && b.agency_id === agencyMatch.id ? 2 : b.agency_id === null ? 1 : 0;
      if (aAgencyScore !== bAgencyScore) return bAgencyScore - aAgencyScore;
      if (a.is_default !== b.is_default) return Number(b.is_default) - Number(a.is_default);
      return b.valid_from.localeCompare(a.valid_from);
    });

    const selectedPriceList = sortedPriceLists[0] as
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
          needs_manual_review: boolean;
        }
      | null = null;

    if (selectedPriceList?.id && routeMatch?.id) {
      const { data: rules } = await admin
        .from("pricing_rules")
        .select("id, route_id, agency_id, service_type, direction, pax_min, pax_max, rule_kind, internal_cost_cents, public_price_cents, agency_price_cents, priority, vehicle_type, time_from, time_to, season_from, season_to, needs_manual_review")
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
        vehicle_type: string | null;
        time_from: string | null;
        time_to: string | null;
        season_from: string | null;
        season_to: string | null;
        needs_manual_review: boolean;
      }>;

      const filtered = candidates.filter((rule) => {
        const agencyOk = rule.agency_id === null || (agencyMatch?.id && rule.agency_id === agencyMatch.id);
        const typeOk = rule.service_type === null || rule.service_type === input.serviceType;
        const directionOk = rule.direction === null || rule.direction === input.direction;
        const paxOk = input.pax >= rule.pax_min && (rule.pax_max === null || input.pax <= rule.pax_max);
        const vehicleOk = rule.vehicle_type === null || (vehicleTypeHint !== null && rule.vehicle_type === vehicleTypeHint);
        const timeOk = (rule.time_from === null || serviceTime >= rule.time_from.slice(0, 5)) && (rule.time_to === null || serviceTime <= rule.time_to.slice(0, 5));
        const seasonOk = (rule.season_from === null || serviceDate >= rule.season_from) && (rule.season_to === null || serviceDate <= rule.season_to);
        return Boolean(agencyOk && typeOk && directionOk && paxOk && vehicleOk && timeOk && seasonOk);
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

    const agencyScore = agencyMatch?.confidence ?? 0;
    const routeScore = routeMatch?.confidence ?? 0;
    const matchConfidence = Math.min(100, Math.max(agencyScore, routeScore));
    const matchQuality = deriveMatchQuality(Boolean(selectedRule), agencyScore, routeScore, Boolean(selectedRule?.needs_manual_review));
    const reviewRequired = !selectedRule || matchQuality !== "certain" || Boolean(selectedRule?.needs_manual_review);
    const matchStatus = reviewRequired ? "needs_review" : "matched";
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
        pax: input.pax,
        booking_kind: input.bookingKind ?? null,
        service_variant: input.serviceVariant ?? null
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
      match_quality: matchQuality,
      match_confidence: matchConfidence || null,
      review_required: reviewRequired,
      match_notes: selectedRule
        ? reviewRequired
          ? `Regola trovata, revisione operatore consigliata | agenzia: ${agencyMatch?.reason ?? "n/d"} | tratta: ${routeMatch?.reason ?? "n/d"}`
          : `Regola trovata con confidenza alta | agenzia: ${agencyMatch?.reason ?? "n/d"} | tratta: ${routeMatch?.reason ?? "n/d"}`
        : `Nessuna regola tariffaria trovata | agenzia: ${agencyMatch?.reason ?? "n/d"} | tratta: ${routeMatch?.reason ?? "n/d"}`
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
      manual_override: false,
      snapshot_json: {
        rule_kind: selectedRule.rule_kind,
        multiplier,
        matched_agency_id: agencyMatch?.id ?? null,
        matched_route_id: routeMatch?.id ?? null,
        match_quality: matchQuality,
        vehicle_type_hint: vehicleTypeHint
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
        pricing_manual_override: false,
        pricing_applied_at: new Date().toISOString()
      })
      .eq("id", input.serviceId)
      .eq("tenant_id", input.tenantId);
  } catch (error) {
    console.error("Pricing match/apply failed", error);
  }
}
