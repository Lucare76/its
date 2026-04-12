import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

function makeAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorizeAdmin(request: NextRequest) {
  const admin = makeAdmin();
  if (!admin) return null;
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const { data: { user } } = await admin.auth.getUser(auth.slice(7));
  if (!user) return null;
  const { data: m } = await admin.from("memberships").select("tenant_id, role").eq("user_id", user.id).maybeSingle();
  const role = parseRole(m?.role);
  // Solo admin
  if (!m?.tenant_id || role !== "admin") return null;
  return { admin, tenantId: m.tenant_id };
}

// ---------------------------------------------------------------------------
// GET /api/agency/margins?year=2026
// Restituisce dati margini per l'anno richiesto (default anno corrente)
// Fonte: services con agency_id + agency_rates (cost_cents, price_cents)
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const ctx = await authorizeAdmin(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const yearParam = request.nextUrl.searchParams.get("year");
  const year = yearParam && /^\d{4}$/.test(yearParam) ? parseInt(yearParam) : new Date().getFullYear();
  const fromDate = `${year}-01-01`;
  const toDate   = `${year}-12-31`;

  // Carica servizi dell'anno con agenzia e tipo servizio
  const { data: services, error: svcErr } = await ctx.admin
    .from("services")
    .select("id, date, booking_service_kind, agency_id, agency_quoted_price_cents")
    .eq("tenant_id", ctx.tenantId)
    .gte("date", fromDate)
    .lte("date", toDate)
    .not("agency_id", "is", null)
    .not("booking_service_kind", "is", null)
    .order("date");

  if (svcErr) return NextResponse.json({ error: svcErr.message }, { status: 500 });

  // Carica agency_rates (tutte le versioni attive)
  const { data: rates, error: rateErr } = await ctx.admin
    .from("agency_rates")
    .select("agency_id, booking_service_kind, line_code, price_cents, cost_cents, valid_from, valid_to")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true);

  if (rateErr) return NextResponse.json({ error: rateErr.message }, { status: 500 });

  // Carica agenzie
  const { data: agencies } = await ctx.admin
    .from("agencies")
    .select("id, name")
    .eq("tenant_id", ctx.tenantId);

  const agencyMap = Object.fromEntries((agencies ?? []).map((a) => [a.id, a.name]));

  // Helper: trova il prezzo e costo attivi per un servizio alla sua data
  function findRate(agencyId: string, kind: string, serviceDate: string) {
    return (rates ?? [])
      .filter((r) =>
        r.agency_id === agencyId &&
        r.booking_service_kind === kind &&
        r.valid_from <= serviceDate &&
        (r.valid_to == null || r.valid_to >= serviceDate)
      )
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0] ?? null;
  }

  // Costruisci righe con margine
  type MarginRow = {
    serviceId: string;
    date: string;
    month: string; // "2026-04"
    agencyId: string;
    agencyName: string;
    kind: string;
    priceCents: number;
    costCents: number | null;
    marginCents: number | null;
  };

  const rows: MarginRow[] = [];
  for (const svc of services ?? []) {
    if (!svc.agency_id || !svc.booking_service_kind) continue;
    const rate = findRate(svc.agency_id, svc.booking_service_kind, svc.date);
    const priceCents = rate?.price_cents ?? svc.agency_quoted_price_cents ?? null;
    const costCents  = rate?.cost_cents ?? null;
    const marginCents = priceCents != null && costCents != null ? priceCents - costCents : null;

    if (priceCents == null) continue; // senza prezzo non calcoliamo

    rows.push({
      serviceId: svc.id,
      date: svc.date,
      month: svc.date.slice(0, 7),
      agencyId: svc.agency_id,
      agencyName: agencyMap[svc.agency_id] ?? "Sconosciuta",
      kind: svc.booking_service_kind,
      priceCents,
      costCents,
      marginCents,
    });
  }

  // --- Totali YTD ---
  const ytd = rows.reduce(
    (acc, r) => {
      acc.services++;
      acc.revenueCents += r.priceCents;
      if (r.costCents != null) acc.costCents += r.costCents;
      if (r.marginCents != null) acc.marginCents += r.marginCents;
      return acc;
    },
    { services: 0, revenueCents: 0, costCents: 0, marginCents: 0 }
  );

  // --- Per mese (12 mesi) ---
  const MONTHS = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const byMonth = MONTHS.map((m) => {
    const mrs = rows.filter((r) => r.month === m);
    return {
      month: m,
      label: new Date(`${m}-01`).toLocaleDateString("it-IT", { month: "short" }),
      services: mrs.length,
      revenueCents: mrs.reduce((s, r) => s + r.priceCents, 0),
      costCents: mrs.reduce((s, r) => s + (r.costCents ?? 0), 0),
      marginCents: mrs.reduce((s, r) => s + (r.marginCents ?? 0), 0),
    };
  });

  // --- Per agenzia ---
  const agencyTotals: Record<string, { name: string; services: number; revenueCents: number; costCents: number; marginCents: number }> = {};
  for (const r of rows) {
    if (!agencyTotals[r.agencyId]) {
      agencyTotals[r.agencyId] = { name: r.agencyName, services: 0, revenueCents: 0, costCents: 0, marginCents: 0 };
    }
    agencyTotals[r.agencyId].services++;
    agencyTotals[r.agencyId].revenueCents += r.priceCents;
    agencyTotals[r.agencyId].costCents += r.costCents ?? 0;
    agencyTotals[r.agencyId].marginCents += r.marginCents ?? 0;
  }
  const byAgency = Object.entries(agencyTotals)
    .map(([id, v]) => ({ agencyId: id, ...v }))
    .sort((a, b) => b.marginCents - a.marginCents);

  // --- Per tipo servizio ---
  const kindTotals: Record<string, { services: number; revenueCents: number; marginCents: number }> = {};
  for (const r of rows) {
    if (!kindTotals[r.kind]) kindTotals[r.kind] = { services: 0, revenueCents: 0, marginCents: 0 };
    kindTotals[r.kind].services++;
    kindTotals[r.kind].revenueCents += r.priceCents;
    kindTotals[r.kind].marginCents += r.marginCents ?? 0;
  }
  const byKind = Object.entries(kindTotals)
    .map(([kind, v]) => ({ kind, ...v }))
    .sort((a, b) => b.revenueCents - a.revenueCents);

  // --- Anni disponibili (per selezione) ---
  const currentYear = new Date().getFullYear();
  const availableYears = [currentYear - 1, currentYear, currentYear + 1].filter((y) => y >= 2024);

  return NextResponse.json({
    year,
    availableYears,
    ytd,
    byMonth,
    byAgency,
    byKind,
    totalRows: rows.length,
  });
}
