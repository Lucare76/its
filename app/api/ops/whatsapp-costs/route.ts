import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type CostEvent = {
  id: string;
  wamid: string;
  recipient_phone: string | null;
  recipient_country_code: string | null;
  booking_id: string | null;
  template_name: string | null;
  status: string;
  status_timestamp: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  billable: boolean | null;
  pricing_category: string | null;
  pricing_type: string | null;
  pricing_model: string | null;
  estimated_cost: number | null;
  estimated_currency: string | null;
  cost_status: "pending" | "free" | "estimated" | "missing_rate" | "failed";
};

type ServiceRow = { id: string; pax: number | null; customer_name: string | null };
type ReconciliationRow = {
  period_start: string;
  period_end: string;
  pricing_category: string | null;
  meta_reported_volume: number;
  meta_reported_cost: number;
};

const rateSchema = z.object({
  country_code: z.string().trim().min(2).max(8),
  currency: z.string().trim().min(3).max(3).default("EUR"),
  pricing_category: z.string().trim().min(1).max(40),
  pricing_type: z.string().trim().max(40).nullable().optional(),
  pricing_model: z.string().trim().max(40).nullable().optional(),
  unit_price: z.number().min(0),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  source: z.string().trim().min(1).max(120).default("manual"),
  is_confirmed: z.boolean().default(false),
});

const settingsSchema = z.object({
  daily_threshold: z.number().min(0).optional(),
  monthly_threshold: z.number().min(0).optional(),
  max_avg_messages_per_passenger: z.number().min(0).optional(),
  anomaly_growth_percent: z.number().min(0).optional(),
});

function eur(value: number | null | undefined) {
  return Number(value ?? 0);
}

function dateKey(iso: string | null | undefined) {
  if (!iso) return null;
  return iso.slice(0, 10);
}

function eventDate(row: CostEvent) {
  return dateKey(row.delivered_at ?? row.status_timestamp ?? row.sent_at ?? row.failed_at);
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function rangeFromPreset(preset: string | null, request: NextRequest) {
  const today = new Date();
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (preset === "today") return { start: todayStart, end: addDays(todayStart, 1) };
  if (preset === "yesterday") return { start: addDays(todayStart, -1), end: todayStart };
  if (preset === "last7") return { start: addDays(todayStart, -6), end: addDays(todayStart, 1) };
  if (preset === "previous_month") {
    const currentStart = startOfUtcMonth(todayStart);
    const previousStart = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 1, 1));
    return { start: previousStart, end: currentStart };
  }
  if (preset === "custom") {
    const startParam = request.nextUrl.searchParams.get("start");
    const endParam = request.nextUrl.searchParams.get("end");
    const start = startParam ? new Date(`${startParam}T00:00:00Z`) : startOfUtcMonth(todayStart);
    const end = endParam ? addDays(new Date(`${endParam}T00:00:00Z`), 1) : addDays(todayStart, 1);
    return { start, end };
  }
  return { start: startOfUtcMonth(todayStart), end: addDays(todayStart, 1) };
}

function inRange(row: CostEvent, start: Date, end: Date) {
  const key = eventDate(row);
  if (!key) return false;
  const date = new Date(`${key}T00:00:00Z`);
  return date >= start && date < end;
}

function sumCost(rows: CostEvent[]) {
  return rows.reduce((sum, row) => sum + eur(row.estimated_cost), 0);
}

function counts(rows: CostEvent[]) {
  const sent = rows.filter((row) => row.sent_at).length;
  const delivered = rows.filter((row) => row.delivered_at || row.read_at).length;
  const read = rows.filter((row) => row.read_at).length;
  const failed = rows.filter((row) => row.failed_at || row.status === "failed").length;
  const free = rows.filter((row) => row.cost_status === "free").length;
  const paid = rows.filter((row) => row.cost_status === "estimated").length;
  const missingRate = rows.filter((row) => row.cost_status === "missing_rate").length;
  return {
    sent,
    delivered,
    read,
    failed,
    free,
    paid,
    missingRate,
    deliveryRate: sent > 0 ? delivered / sent : 0,
    readRate: delivered > 0 ? read / delivered : 0,
  };
}

function groupByDay(rows: CostEvent[], reconciliations: ReconciliationRow[]) {
  const byDay = new Map<string, CostEvent[]>();
  for (const row of rows) {
    const key = eventDate(row);
    if (!key) continue;
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => {
      const dayCounts = counts(dayRows);
      const reconciled = reconciliations
        .filter((row) => row.period_start <= date && row.period_end >= date)
        .reduce((sum, row) => sum + eur(row.meta_reported_cost), 0);
      const estimated = sumCost(dayRows);
      return {
        date,
        volume: dayRows.length,
        free: dayCounts.free,
        paid: dayCounts.paid,
        missing_rate: dayCounts.missingRate,
        estimated_cost: estimated,
        reconciled_cost: reconciled,
        difference: reconciled ? estimated - reconciled : null,
      };
    });
}

function groupByCategory(rows: CostEvent[]) {
  const categories = new Map<string, CostEvent[]>();
  for (const row of rows) {
    const key = row.cost_status === "free" ? "gratuiti" : row.pricing_category ?? "da_determinare";
    categories.set(key, [...(categories.get(key) ?? []), row]);
  }
  return [...categories.entries()].map(([category, categoryRows]) => ({
    category,
    volume: categoryRows.length,
    estimated_cost: sumCost(categoryRows),
    free: categoryRows.filter((row) => row.cost_status === "free").length,
    missing_rate: categoryRows.filter((row) => row.cost_status === "missing_rate").length,
  }));
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;
  const preset = request.nextUrl.searchParams.get("range");
  const { start, end } = rangeFromPreset(preset, request);
  const category = request.nextUrl.searchParams.get("category");
  const status = request.nextUrl.searchParams.get("status");
  const country = request.nextUrl.searchParams.get("country");
  const template = request.nextUrl.searchParams.get("template");

  const since = addDays(start, -40).toISOString();
  const { data: events, error } = await auth.admin
    .from("whatsapp_message_events")
    .select("*")
    .eq("tenant_id", tenantId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const allRows = ((events ?? []) as CostEvent[]).filter((row) => {
    if (!inRange(row, start, end)) return false;
    if (category && row.pricing_category !== category && row.cost_status !== category) return false;
    if (status && row.status !== status && row.cost_status !== status) return false;
    if (country && row.recipient_country_code !== country) return false;
    if (template && row.template_name !== template) return false;
    return true;
  });

  const today = new Date();
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const yesterdayStart = addDays(todayStart, -1);
  const monthStart = startOfUtcMonth(todayStart);
  const previousMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
  const monthEnd = addDays(endOfUtcMonth(todayStart), 1);
  const daysInMonth = endOfUtcMonth(todayStart).getUTCDate();
  const elapsedDays = Math.max(1, today.getUTCDate());

  const allForSummary = (events ?? []) as CostEvent[];
  const todayRows = allForSummary.filter((row) => inRange(row, todayStart, addDays(todayStart, 1)));
  const yesterdayRows = allForSummary.filter((row) => inRange(row, yesterdayStart, todayStart));
  const currentMonthRows = allForSummary.filter((row) => inRange(row, monthStart, monthEnd));
  const previousMonthRows = allForSummary.filter((row) => inRange(row, previousMonthStart, monthStart));

  const bookingIds = Array.from(new Set(allRows.map((row) => row.booking_id).filter(Boolean) as string[]));
  const { data: services } = bookingIds.length
    ? await auth.admin.from("services").select("id, pax, customer_name").eq("tenant_id", tenantId).in("id", bookingIds)
    : { data: [] };
  const serviceRows = (services ?? []) as ServiceRow[];
  const paxByBooking = new Map(serviceRows.map((row) => [row.id, Math.max(Number(row.pax ?? 0), 0)]));
  const passengerCount = Array.from(new Set(allRows.map((row) => row.booking_id).filter(Boolean) as string[]))
    .reduce((sum, id) => sum + (paxByBooking.get(id) || 1), 0);

  const { data: reconciliations } = await auth.admin
    .from("whatsapp_cost_reconciliations")
    .select("period_start, period_end, pricing_category, meta_reported_volume, meta_reported_cost")
    .eq("tenant_id", tenantId)
    .gte("period_end", start.toISOString().slice(0, 10))
    .lte("period_start", addDays(end, -1).toISOString().slice(0, 10));

  const { data: settings } = await auth.admin
    .from("whatsapp_cost_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const { data: rates } = await auth.admin
    .from("whatsapp_pricing_rates")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("valid_from", { ascending: false })
    .limit(100);

  const selectedCounts = counts(allRows);
  const estimatedCost = sumCost(allRows);
  const delivered = selectedCounts.delivered;
  const currentMonthCost = sumCost(currentMonthRows);
  const projection = (currentMonthCost / elapsedDays) * daysInMonth;
  const reconciledCost = ((reconciliations ?? []) as ReconciliationRow[])
    .reduce((sum, row) => sum + eur(row.meta_reported_cost), 0);
  const avgMessagesPerPassenger = passengerCount > 0 ? delivered / passengerCount : 0;
  const avgCostPerPassenger = passengerCount > 0 ? estimatedCost / passengerCount : 0;

  const thresholdSettings = {
    daily_threshold: Number(settings?.daily_threshold ?? 5),
    monthly_threshold: Number(settings?.monthly_threshold ?? 100),
    max_avg_messages_per_passenger: Number(settings?.max_avg_messages_per_passenger ?? 3),
    anomaly_growth_percent: Number(settings?.anomaly_growth_percent ?? 50),
  };
  const yesterdayCost = sumCost(yesterdayRows);
  const todayCost = sumCost(todayRows);
  const growth = yesterdayCost > 0 ? ((todayCost - yesterdayCost) / yesterdayCost) * 100 : 0;
  const alerts = [
    todayCost > thresholdSettings.daily_threshold ? `Costo Meta stimato oggi sopra soglia: ${todayCost.toFixed(2)} EUR.` : null,
    currentMonthCost > thresholdSettings.monthly_threshold ? `Costo Meta stimato mese sopra soglia: ${currentMonthCost.toFixed(2)} EUR.` : null,
    avgMessagesPerPassenger > thresholdSettings.max_avg_messages_per_passenger ? `Media messaggi per passeggero sopra soglia: ${avgMessagesPerPassenger.toFixed(2)}.` : null,
    growth > thresholdSettings.anomaly_growth_percent ? `Costo giornaliero in crescita del ${growth.toFixed(0)}% rispetto a ieri.` : null,
    selectedCounts.missingRate > 0 ? `${selectedCounts.missingRate} messaggi con costo da determinare: tariffa mancante.` : null,
  ].filter(Boolean);

  const passengersByBooking = serviceRows.map((service) => {
    const rows = allRows.filter((row) => row.booking_id === service.id);
    return {
      booking_id: service.id,
      customer_name: service.customer_name,
      pax: service.pax ?? 0,
      messages: rows.length,
      delivered: counts(rows).delivered,
      estimated_cost: sumCost(rows),
    };
  }).sort((a, b) => b.messages - a.messages).slice(0, 20);

  const last30Start = addDays(todayStart, -29);
  const last30Rows = allForSummary.filter((row) => inRange(row, last30Start, addDays(todayStart, 1)));
  const futureRates = ((rates ?? []) as Array<Record<string, unknown>>).filter((rate) => String(rate.valid_from ?? "") >= "2026-10-01");
  const simulation = {
    label: "Simulazione nuove tariffe",
    current_cost: sumCost(last30Rows),
    simulated_cost: last30Rows.reduce((sum, row) => {
      const futureRate = futureRates.find((rate) =>
        rate.country_code === row.recipient_country_code &&
        rate.pricing_category === row.pricing_category
      );
      return sum + (futureRate ? Number(futureRate.unit_price ?? 0) : eur(row.estimated_cost));
    }, 0),
    volume: last30Rows.length,
    future_rates_count: futureRates.length,
  };

  return NextResponse.json({
    ok: true,
    range: { start: start.toISOString().slice(0, 10), end: addDays(end, -1).toISOString().slice(0, 10) },
    labels: {
      estimated: "Costo Meta stimato",
      billed: "Costo fatturato da Meta",
      tooltip: "Il valore viene calcolato sui messaggi consegnati e sulle tariffe disponibili. La fattura Meta rappresenta il costo contabile definitivo.",
    },
    cards: {
      estimated_today: todayCost,
      estimated_yesterday: yesterdayCost,
      estimated_current_month: currentMonthCost,
      estimated_previous_month: sumCost(previousMonthRows),
      projected_month_end: projection,
      delivered_current_month: counts(currentMonthRows).delivered,
      avg_cost_per_message: delivered > 0 ? estimatedCost / delivered : 0,
      avg_cost_per_passenger: avgCostPerPassenger,
      avg_messages_per_passenger: avgMessagesPerPassenger,
      reconciled_cost: reconciledCost,
      reconciliation_difference: reconciledCost ? estimatedCost - reconciledCost : null,
    },
    counts: selectedCounts,
    categories: groupByCategory(allRows),
    daily: groupByDay(allRows, (reconciliations ?? []) as ReconciliationRow[]),
    passengers: {
      contacted: passengerCount,
      top: passengersByBooking,
    },
    filters: {
      categories: Array.from(new Set(allForSummary.map((row) => row.pricing_category).filter(Boolean))),
      countries: Array.from(new Set(allForSummary.map((row) => row.recipient_country_code).filter(Boolean))),
      templates: Array.from(new Set(allForSummary.map((row) => row.template_name).filter(Boolean))),
    },
    settings: thresholdSettings,
    alerts,
    simulation: {
      ...simulation,
      difference: simulation.simulated_cost - simulation.current_cost,
      difference_percent: simulation.current_cost > 0 ? ((simulation.simulated_cost - simulation.current_cost) / simulation.current_cost) * 100 : null,
    },
    rates: rates ?? [],
    updated_at: new Date().toISOString(),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;
  const body = await request.json().catch(() => null) as { kind?: string; payload?: unknown } | null;
  if (!body?.kind) return NextResponse.json({ error: "Payload non valido." }, { status: 400 });

  if (body.kind === "rate") {
    const parsed = rateSchema.safeParse(body.payload);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Tariffa non valida." }, { status: 400 });
    const row = {
      ...parsed.data,
      tenant_id: tenantId,
      country_code: parsed.data.country_code.toUpperCase(),
      pricing_category: parsed.data.pricing_category.toLowerCase(),
      pricing_type: parsed.data.pricing_type?.trim() || null,
      pricing_model: parsed.data.pricing_model?.trim() || null,
      valid_to: parsed.data.valid_to || null,
    };
    const { data, error } = await auth.admin.from("whatsapp_pricing_rates").insert(row).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, rate: data });
  }

  if (body.kind === "settings") {
    const parsed = settingsSchema.safeParse(body.payload);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Impostazioni non valide." }, { status: 400 });
    const { data, error } = await auth.admin
      .from("whatsapp_cost_settings")
      .upsert({ tenant_id: tenantId, ...parsed.data }, { onConflict: "tenant_id" })
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, settings: data });
  }

  return NextResponse.json({ error: "Operazione non supportata." }, { status: 400 });
}
