import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { usdToEur } from "@/lib/ai-pricing";

export const runtime = "nodejs";

type UsageRow = {
  created_at: string;
  cost_usd: number;
  failed: boolean;
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const historyStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await auth.admin
    .from("ai_usage_log")
    .select("created_at, cost_usd, failed")
    .eq("tenant_id", auth.membership.tenant_id)
    .gte("created_at", historyStart < startOfMonth ? historyStart : startOfMonth)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const usageRows = (rows ?? []) as UsageRow[];

  const monthCostUsd = usageRows
    .filter((row) => row.created_at >= startOfMonth)
    .reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);

  const { data: lastRows } = await auth.admin
    .from("ai_usage_log")
    .select("created_at, cost_usd, failed, model, source")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("created_at", { ascending: false })
    .limit(1);
  const lastRow = (lastRows ?? [])[0] as (UsageRow & { model: string; source: string }) | undefined;

  const dailyMap = new Map<string, number>();
  for (const row of usageRows) {
    if (row.created_at < historyStart) continue;
    const day = row.created_at.slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + Number(row.cost_usd ?? 0));
  }
  const daily = Array.from(dailyMap.entries())
    .map(([date, costUsd]) => ({ date, cost_usd: costUsd, cost_eur: usdToEur(costUsd) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({
    ok: true,
    month_cost_usd: monthCostUsd,
    month_cost_eur: usdToEur(monthCostUsd),
    last_import: lastRow
      ? {
          created_at: lastRow.created_at,
          cost_usd: Number(lastRow.cost_usd ?? 0),
          cost_eur: usdToEur(Number(lastRow.cost_usd ?? 0)),
          failed: Boolean(lastRow.failed),
          model: lastRow.model,
          source: lastRow.source
        }
      : null,
    daily
  });
}
