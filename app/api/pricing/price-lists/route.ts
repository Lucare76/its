import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

async function hasColumn(admin: any, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

const priceListPayloadSchema = z
  .object({
    name: z.string().min(2).max(120),
    currency: z.string().length(3).default("EUR"),
    valid_from: z.string().min(10).max(10),
    valid_to: z.string().optional().or(z.literal("")),
    agency_id: z.string().uuid().optional().or(z.literal("")),
    is_default: z.boolean().default(false)
  })
  .transform((value) => ({
    name: value.name.trim(),
    currency: value.currency.toUpperCase(),
    valid_from: value.valid_from,
    valid_to: value.valid_to || null,
    agency_id: value.agency_id || null,
    is_default: value.is_default
  }));

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const parsed = priceListPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Listino non valido." }, { status: 400 });
    }

    const payload: Record<string, unknown> = {
      tenant_id: auth.membership.tenant_id,
      name: parsed.data.name,
      currency: parsed.data.currency,
      valid_from: parsed.data.valid_from,
      valid_to: parsed.data.valid_to,
      is_default: parsed.data.is_default,
      active: true
    };

    if (await hasColumn(auth.admin, "price_lists", "agency_id")) {
      payload.agency_id = parsed.data.agency_id;
    }
    if (await hasColumn(auth.admin, "price_lists", "created_by_user_id")) {
      payload.created_by_user_id = auth.user.id;
    }

    const { data, error } = await auth.admin
      .from("price_lists")
      .insert(payload)
      .select("id, agency_id, name")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      price_list: {
        id: String(data?.id ?? ""),
        agency_id: data?.agency_id ? String(data.agency_id) : null,
        name: String(data?.name ?? parsed.data.name)
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const priceListId = typeof body?.price_list_id === "string" ? body.price_list_id : "";
    if (!priceListId) {
      return NextResponse.json({ error: "Price list ID mancante." }, { status: 400 });
    }

    const parsed = priceListPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Listino non valido." }, { status: 400 });
    }

    const payload: Record<string, unknown> = {
      name: parsed.data.name,
      currency: parsed.data.currency,
      valid_from: parsed.data.valid_from,
      valid_to: parsed.data.valid_to,
      is_default: parsed.data.is_default
    };

    if (await hasColumn(auth.admin, "price_lists", "agency_id")) {
      payload.agency_id = parsed.data.agency_id;
    }

    const { error } = await auth.admin
      .from("price_lists")
      .update(payload)
      .eq("id", priceListId)
      .eq("tenant_id", auth.membership.tenant_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null);
    const priceListId = typeof body?.price_list_id === "string" ? body.price_list_id : "";
    if (!priceListId) {
      return NextResponse.json({ error: "Price list ID mancante." }, { status: 400 });
    }

    const { error } = await auth.admin
      .from("price_lists")
      .delete()
      .eq("id", priceListId)
      .eq("tenant_id", auth.membership.tenant_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}
