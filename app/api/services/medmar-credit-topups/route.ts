/**
 * GET/POST /api/services/medmar-credit-topups — ricariche credito Medmar
 * manuale (medmar_credit_topups). GET restituisce l'elenco (per il riepilogo
 * impostazioni), POST registra una nuova ricarica. Nessun token, nessun PDF,
 * nessuna chiamata Medmar, nessun dato sensibile.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("medmar_credit_topups")
    .select("id, amount_cents, topup_date, notes, created_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("topup_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: "Errore lettura ricariche credito." }, { status: 500 });

  return NextResponse.json({ ok: true, topups: data ?? [] });
}

const postSchema = z.object({
  amount_cents: z.number().int().positive(),
  topup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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

  const { amount_cents, topup_date, notes } = parsed.data;
  const tenantId = auth.membership.tenant_id;

  const { data, error } = await auth.admin
    .from("medmar_credit_topups")
    .insert({
      tenant_id: tenantId,
      amount_cents,
      ...(topup_date ? { topup_date } : {}),
      notes: notes?.trim() ? notes.trim().slice(0, 500) : null,
      created_by: auth.user.id,
    })
    .select("id, amount_cents, topup_date, notes, created_at")
    .single();

  if (error) return NextResponse.json({ ok: false, error: "Errore salvataggio ricarica credito." }, { status: 500 });

  return NextResponse.json({ ok: true, topup: data });
}
