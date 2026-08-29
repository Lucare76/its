import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { todayIsoDateRome, type FerryPickupRule } from "@/lib/ferry-pickup-rules";
import {
  serviceMatchesRuleForImpact,
  mergeRuleOverride,
  IMPACT_OVERRIDABLE_FIELDS,
  type ImpactServiceCandidate,
} from "@/lib/ferry-pickup-rules-impact";

export const runtime = "nodejs";

/**
 * GET /api/ferry-pickup-rules/[id]/impact — SOLA LETTURA.
 * Stima quanti servizi futuri e quante convocazioni WhatsApp già inviate
 * potrebbero essere interessati da una modifica a questa regola, PRIMA che
 * la modifica venga salvata. Nessuna scrittura, nessun reinvio, nessun
 * ricalcolo dei servizi esistenti — solo un conteggio a scopo di conferma
 * (vedi conflictErrorResponse/handleSave lato UI per il modal "Conferma modifica").
 *
 * Query params opzionali (whitelist in IMPACT_OVERRIDABLE_FIELDS): se
 * presenti, sovrascrivono i campi corrispondenti della regola SALVATA prima
 * di valutare l'impatto — la UI li passa con i valori del draft in modifica,
 * cosi' l'impact preview valuta la modifica PROPOSTA e non solo quella già
 * persistita (bug reale corretto il 2026-08-30: senza questo, cambiare
 * company/departure_time/zone non veniva mai riflesso nel conteggio).
 * Senza query params, valuta la regola così com'è salvata oggi (retro-
 * compatibile con chiamate che vogliono solo lo stato attuale).
 *
 * Match best-effort in-memory su un set già limitato a date >= oggi e allo
 * stesso tenant (una sola query su services + una su ciascuna tabella di
 * convocazione, nessun N+1): non è il matcher esatto di resolveOperationalConnection,
 * ma una stima sufficiente per decidere se serve conferma.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor"],
    auditPrefix: "ferry_pickup_rules_impact",
  });
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const { data: rule, error: ruleError } = await auth.admin
    .from("ferry_pickup_rules")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (ruleError) {
    return NextResponse.json({ error: ruleError.message }, { status: 500 });
  }
  if (!rule) {
    return NextResponse.json({ error: "Regola non trovata." }, { status: 404 });
  }

  const overrides: Partial<Record<(typeof IMPACT_OVERRIDABLE_FIELDS)[number], string | null>> = {};
  for (const key of IMPACT_OVERRIDABLE_FIELDS) {
    const raw = request.nextUrl.searchParams.get(key);
    if (raw !== null) {
      overrides[key] = raw === "" ? null : raw;
    }
  }
  const r = mergeRuleOverride(rule as FerryPickupRule, overrides);
  const today = todayIsoDateRome();

  // Una sola query: bound naturale su date >= oggi tiene il set piccolo,
  // niente fetch per-riga aggiuntivo.
  const { data: futureServices, error: servicesError } = await auth.admin
    .from("services")
    .select("id, date, time, hotel_id, booking_service_kind, billing_party_name, vessel, hotels(zone)")
    .eq("tenant_id", auth.membership.tenant_id)
    .gte("date", today);

  if (servicesError) {
    return NextResponse.json({ error: servicesError.message }, { status: 500 });
  }

  type ServiceRow = {
    id: string;
    date: string;
    time: string | null;
    hotel_id: string | null;
    booking_service_kind: string | null;
    billing_party_name: string | null;
    vessel: string | null;
    hotels: { zone: string | null } | { zone: string | null }[] | null;
  };

  const matched = ((futureServices ?? []) as ServiceRow[]).filter((s) => {
    const candidate: ImpactServiceCandidate = {
      id: s.id,
      time: s.time,
      hotel_id: s.hotel_id,
      booking_service_kind: s.booking_service_kind,
      billing_party_name: s.billing_party_name,
      vessel: s.vessel,
      hotel_zone_raw: Array.isArray(s.hotels) ? s.hotels[0]?.zone ?? null : s.hotels?.zone ?? null,
    };
    return serviceMatchesRuleForImpact(r, candidate);
  });

  const serviceIds = matched.map((s) => s.id);

  let sentConvocations = 0;
  if (serviceIds.length > 0) {
    const [medmarRes, snavRes] = await Promise.all([
      auth.admin
        .from("medmar_convocation_rows")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", auth.membership.tenant_id)
        .in("service_id", serviceIds)
        .not("sent_at", "is", null),
      auth.admin
        .from("snav_convocation_rows")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", auth.membership.tenant_id)
        .in("service_id", serviceIds)
        .not("sent_at", "is", null),
    ]);
    sentConvocations = (medmarRes.count ?? 0) + (snavRes.count ?? 0);
  }

  return NextResponse.json({
    ok: true,
    futureServices: matched.length,
    sentConvocations,
  });
}
