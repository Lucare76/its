/**
 * FASE A.2 — GET /api/mario-assistant/usage-summary
 *
 * Riepilogo costi LLM dell'Assistente Mario per l'UTENTE corrente nel proprio
 * tenant (§11 — mai cross-tenant, mai cross-user). Una sola query aggregata
 * sulla finestra del mese (nessun N+1), poi derivazione in memoria di
 * `lastRequest` / `today` / `month`.
 *
 * "sessione": aggregata client-side dalla chat corrente (§13) — qui non serve
 * un session_id server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getMarioLlmModel } from "@/lib/server/mario-assistant/llm-client";
import { isMarioLlmPricingConfigured } from "@/lib/server/mario-assistant/pricing";

export const runtime = "nodejs";

type Row = {
  created_at: string;
  model: string;
  action: string | null;
  fallback_used: boolean;
  failed: boolean;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: string | number | null;
};

type Bucket = { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null };

function emptyBucket(): Bucket {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function fold(rows: Row[]): Bucket {
  const b = emptyBucket();
  let sawCost = false;
  let missingCost = false;
  for (const r of rows) {
    b.calls += 1;
    b.inputTokens += Number(r.input_tokens ?? 0);
    b.outputTokens += Number(r.output_tokens ?? 0);
    if (r.total_cost_usd != null) {
      sawCost = true;
      (b.costUsd as number) += Number(r.total_cost_usd);
    } else if (!r.failed && (Number(r.input_tokens ?? 0) > 0 || Number(r.output_tokens ?? 0) > 0)) {
      missingCost = true; // c'erano token ma la tariffa non era configurata
    }
  }
  // Se nessuna riga aveva un costo E almeno una aveva token non prezzati → null.
  if (!sawCost && missingCost) b.costUsd = null;
  return b;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const { data, error } = await auth.admin
    .from("mario_llm_usage")
    .select("created_at, model, action, fallback_used, failed, input_tokens, output_tokens, total_cost_usd")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", auth.user.id)
    .gte("created_at", startOfMonth)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    // Tabella assente / non applicata: degrada in modo pulito, non 500.
    return NextResponse.json({
      ok: true,
      pricingConfigured: isMarioLlmPricingConfigured(getMarioLlmModel()),
      unavailable: true,
      lastRequest: null,
      today: emptyBucket(),
      month: emptyBucket(),
    });
  }

  const rows = (data ?? []) as Row[];
  const monthBucket = fold(rows);
  const todayBucket = fold(rows.filter((r) => r.created_at >= startOfDay));

  const last = rows[0];
  const lastRequest = last
    ? {
        createdAt: last.created_at,
        model: last.model,
        action: last.action,
        fallbackUsed: Boolean(last.fallback_used),
        failed: Boolean(last.failed),
        inputTokens: Number(last.input_tokens ?? 0),
        outputTokens: Number(last.output_tokens ?? 0),
        costUsd: last.total_cost_usd != null ? Number(last.total_cost_usd) : null,
      }
    : null;

  return NextResponse.json({
    ok: true,
    pricingConfigured: isMarioLlmPricingConfigured(getMarioLlmModel()),
    lastRequest,
    today: todayBucket,
    month: monthBucket,
  });
}
