import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const { data, error } = await auth.admin
    .from("tenants")
    .select("quote_iban,quote_swift_code,quote_bank_holder,quote_payment_instructions")
    .eq("id", tenantId)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    iban:                 data?.quote_iban ?? null,
    swift_code:           data?.quote_swift_code ?? null,
    bank_account_holder:  data?.quote_bank_holder ?? null,
    payment_instructions: data?.quote_payment_instructions ?? null,
  });
}

const patchSchema = z.object({
  iban:                 z.string().max(50).nullable().optional(),
  swift_code:           z.string().max(20).nullable().optional(),
  bank_account_holder:  z.string().max(200).nullable().optional(),
  payment_instructions: z.string().max(1000).nullable().optional(),
});

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const d = parsed.data;
  const updates: Record<string, string | null> = {};
  if (d.iban                 !== undefined) updates.quote_iban                 = d.iban?.trim() || null;
  if (d.swift_code           !== undefined) updates.quote_swift_code           = d.swift_code?.trim() || null;
  if (d.bank_account_holder  !== undefined) updates.quote_bank_holder          = d.bank_account_holder?.trim() || null;
  if (d.payment_instructions !== undefined) updates.quote_payment_instructions = d.payment_instructions?.trim() || null;

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const { error } = await auth.admin
    .from("tenants")
    .update(updates)
    .eq("id", auth.membership.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
