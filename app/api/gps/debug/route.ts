/**
 * GET /api/gps/debug
 * Endpoint temporaneo di debug: restituisce il JSON grezzo di Kinesis
 * (primo elemento) per identificare i nomi dei campi reali.
 * Solo admin. Da rimuovere dopo il debug.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchRadiusAllPositionsWithRaw } from "@/lib/server/radius-adapter";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  try {
    const { normalized, raw_json } = await fetchRadiusAllPositionsWithRaw();
    const rawArray = Array.isArray(raw_json)
      ? raw_json
      : Object.values(raw_json as object).find(Array.isArray) ?? [];
    return NextResponse.json({
      ok: true,
      raw_first_item: (rawArray as unknown[])[0] ?? null,
      raw_top_level_keys: Object.keys(raw_json as object),
      normalized_first: normalized[0] ?? null,
      total: normalized.length
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore" },
      { status: 502 }
    );
  }
}
