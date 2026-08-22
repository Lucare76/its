/**
 * GET/POST /api/services/medmar-credit-settings — impostazioni credito
 * Medmar manuale (credito iniziale, soglia attenzione). Le ricariche hanno
 * una route separata: /api/services/medmar-credit-topups. Sola
 * lettura/scrittura sul setting stesso — nessun token, nessun PDF, nessuna
 * chiamata Medmar, nessun dato sensibile.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("medmar_credit_settings")
    .select("initial_credit_cents, safety_threshold_cents, notes, updated_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: "Errore lettura impostazioni credito." }, { status: 500 });

  return NextResponse.json({
    ok: true,
    settings: data
      ? {
          initial_credit_cents: data.initial_credit_cents,
          safety_threshold_cents: data.safety_threshold_cents,
          notes: data.notes,
          updated_at: data.updated_at,
        }
      : null,
  });
}

const postSchema = z.object({
  initial_credit_cents: z.number().int().min(0),
  safety_threshold_cents: z.number().int().min(0),
  notes: z.string().max(2000).nullable().optional(),
});

/** Scrittura riservata ad admin/supervisor (operator legge, non modifica) — coerente con RLS della migration 0240. */
export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const { initial_credit_cents, safety_threshold_cents, notes } = parsed.data;
  const tenantId = auth.membership.tenant_id;

  const { error } = await auth.admin
    .from("medmar_credit_settings")
    .upsert(
      {
        tenant_id: tenantId,
        initial_credit_cents,
        safety_threshold_cents,
        notes: notes?.trim() ? notes.trim().slice(0, 500) : null,
        updated_by: auth.user.id,
      },
      { onConflict: "tenant_id" }
    );

  if (error) return NextResponse.json({ ok: false, error: "Errore salvataggio impostazioni credito." }, { status: 500 });

  return NextResponse.json({ ok: true });
}
