import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveContext, computeAnalytics } from "@/lib/server/analytics";

export const runtime = "nodejs";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function shiftYearMinus1(iso: string) {
  return `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function defaultRange() {
  const today = new Date();
  const from = new Date(today.getFullYear(), 0, 1); // 1 Jan current year
  return { dateFrom: isoDate(from), dateTo: isoDate(today) };
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await resolveContext(request);
    if (ctx instanceof NextResponse) return ctx;

    const sp = new URL(request.url).searchParams;
    const defaults = defaultRange();

    const parsed = z.object({
      dateFrom: dateSchema.optional(),
      dateTo: dateSchema.optional(),
    }).safeParse({
      dateFrom: sp.get("dateFrom") ?? undefined,
      dateTo: sp.get("dateTo") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Date non valide." }, { status: 400 });
    }

    const dateFrom = parsed.data.dateFrom ?? defaults.dateFrom;
    const dateTo = parsed.data.dateTo ?? defaults.dateTo;
    const lyFrom = shiftYearMinus1(dateFrom);
    const lyTo = shiftYearMinus1(dateTo);
    const threshold = Number(process.env.ANALYTICS_PUNCTUALITY_THRESHOLD_MINUTES ?? "15");
    const t = Number.isFinite(threshold) ? threshold : 15;

    const [current, lastYear] = await Promise.all([
      computeAnalytics(ctx.admin, ctx.tenantId, dateFrom, dateTo, t),
      computeAnalytics(ctx.admin, ctx.tenantId, lyFrom, lyTo, t),
    ]);

    // Confronto mensile: aggrega dailyTrend per mese
    function groupByMonth(trend: Array<{ date: string; services: number; pax: number; revenue_cents: number }>) {
      const m = new Map<string, { services: number; pax: number; revenue_cents: number }>();
      for (const d of trend) {
        const key = d.date.slice(0, 7);
        const existing = m.get(key) ?? { services: 0, pax: 0, revenue_cents: 0 };
        existing.services += d.services;
        existing.pax += d.pax;
        existing.revenue_cents += d.revenue_cents;
        m.set(key, existing);
      }
      return m;
    }

    const curMap = groupByMonth(current.dailyTrend);
    const lyMap = groupByMonth(lastYear.dailyTrend);

    // Unisce tutti i mesi presenti in entrambi i periodi (normalizzati al mese corrente)
    const allCurrentMonths = [...new Set([
      ...curMap.keys(),
      ...[...lyMap.keys()].map((k) => `${Number(k.slice(0, 4)) + 1}${k.slice(4)}`),
    ])].sort();

    const monthlyComparison = allCurrentMonths.map((month) => {
      const lyMonth = shiftYearMinus1(month);
      const cur = curMap.get(month) ?? { services: 0, pax: 0, revenue_cents: 0 };
      const ly = lyMap.get(lyMonth) ?? { services: 0, pax: 0, revenue_cents: 0 };
      return {
        month, // e.g. "2026-03"
        lyMonth, // e.g. "2025-03"
        curServices: cur.services,
        lyServices: ly.services,
        curRevenueCents: cur.revenue_cents,
        lyRevenueCents: ly.revenue_cents,
        curPax: cur.pax,
        lyPax: ly.pax,
      };
    });

    // Delta KPI
    function delta(cur: number, ly: number) {
      if (ly === 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - ly) / ly) * 1000) / 10;
    }

    const kpiDelta = {
      services: delta(current.kpi.totalServices, lastYear.kpi.totalServices),
      revenue: delta(current.kpi.totalRevenueCents, lastYear.kpi.totalRevenueCents),
      pax: delta(current.kpi.totalPax, lastYear.kpi.totalPax),
      punctuality: Math.round((current.kpi.punctualityRate - lastYear.kpi.punctualityRate) * 10) / 10,
      cancellation: Math.round((current.kpi.cancellationRate - lastYear.kpi.cancellationRate) * 10) / 10,
    };

    // Confronto agenzie
    const lyAgencyMap = new Map(lastYear.agencyRank.map((a) => [a.agency_id, a]));
    const agencyYoY = current.agencyRank.map((a) => {
      const ly = lyAgencyMap.get(a.agency_id);
      return {
        agency_id: a.agency_id,
        agency_name: a.agency_name,
        curServices: a.services,
        lyServices: ly?.services ?? 0,
        curRevenueCents: a.revenue_cents,
        lyRevenueCents: ly?.revenue_cents ?? 0,
        delta: delta(a.revenue_cents, ly?.revenue_cents ?? 0),
      };
    }).sort((a, b) => b.curRevenueCents - a.curRevenueCents);

    return NextResponse.json({
      dateFrom, dateTo, lyFrom, lyTo,
      current: { kpi: current.kpi },
      lastYear: { kpi: lastYear.kpi },
      kpiDelta,
      monthlyComparison,
      agencyYoY,
    });
  } catch (err) {
    console.error("YoY analytics error", err);
    return NextResponse.json({ error: "Errore calcolo YoY." }, { status: 500 });
  }
}
