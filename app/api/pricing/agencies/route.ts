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

const unique = (items: string[]) => Array.from(new Set(items));

const agencyPayloadSchema = z
  .object({
    name: z.string().min(2).max(120),
    legal_name: z.string().max(160).nullable().optional(),
    billing_name: z.string().max(160).nullable().optional(),
    contact_email: z.string().email().max(160).nullable().optional(),
    booking_email: z.string().email().max(160).nullable().optional(),
    contact_emails: z.array(z.string().email().max(160)).optional().default([]),
    booking_emails: z.array(z.string().email().max(160)).optional().default([]),
    phone: z.string().max(60).nullable().optional(),
    parser_key_hint: z.string().max(80).nullable().optional(),
    sender_domains: z.array(z.string().min(1).max(160)).optional().default([]),
    default_enabled_booking_kinds: z.array(z.string().min(1).max(120)).optional().default([]),
    default_pricing_notes: z.string().max(1000).optional().default(""),
    notes: z.string().max(2000).optional().default(""),
    vat_number: z.string().max(32).nullable().optional(),
    pec_email: z.string().email().max(160).nullable().optional(),
    sdi_code: z.string().max(16).nullable().optional()
  })
  .transform((value) => {
    const contactEmail = value.contact_email ? value.contact_email.trim().toLowerCase() : null;
    const bookingEmail = value.booking_email ? value.booking_email.trim().toLowerCase() : null;
    const contactEmails = unique([...(contactEmail ? [contactEmail] : []), ...value.contact_emails.map((item) => item.trim().toLowerCase())]);
    const bookingEmails = unique([...(bookingEmail ? [bookingEmail] : []), ...value.booking_emails.map((item) => item.trim().toLowerCase())]);

    return {
      name: value.name.trim(),
      legal_name: value.legal_name?.trim() || null,
      billing_name: value.billing_name?.trim() || null,
      contact_email: contactEmail ?? contactEmails[0] ?? null,
      booking_email: bookingEmail ?? bookingEmails[0] ?? null,
      contact_emails: contactEmails,
      booking_emails: bookingEmails,
      phone: value.phone?.trim() || null,
      parser_key_hint: value.parser_key_hint?.trim() || null,
      sender_domains: unique(value.sender_domains.map((item) => item.trim().toLowerCase()).filter(Boolean)),
      default_enabled_booking_kinds: unique(value.default_enabled_booking_kinds.map((item) => item.trim()).filter(Boolean)),
      default_pricing_notes: value.default_pricing_notes || "",
      notes: value.notes || "",
      vat_number: value.vat_number?.trim() || null,
      pec_email: value.pec_email ? value.pec_email.trim().toLowerCase() : null,
      sdi_code: value.sdi_code?.trim() || null
    };
  });

async function buildAgencyPayload(admin: any, parsed: z.infer<typeof agencyPayloadSchema>) {
  const payload: Record<string, unknown> = {
    name: parsed.name,
    legal_name: parsed.legal_name,
    billing_name: parsed.billing_name,
    contact_email: parsed.contact_email,
    booking_email: parsed.booking_email,
    phone: parsed.phone,
    parser_key_hint: parsed.parser_key_hint,
    sender_domains: parsed.sender_domains,
    default_enabled_booking_kinds: parsed.default_enabled_booking_kinds,
    default_pricing_notes: parsed.default_pricing_notes,
    notes: parsed.notes
  };

  if (await hasColumn(admin, "agencies", "contact_emails")) payload.contact_emails = parsed.contact_emails;
  if (await hasColumn(admin, "agencies", "booking_emails")) payload.booking_emails = parsed.booking_emails;
  if (await hasColumn(admin, "agencies", "vat_number")) payload.vat_number = parsed.vat_number;
  if (await hasColumn(admin, "agencies", "pec_email")) payload.pec_email = parsed.pec_email;
  if (await hasColumn(admin, "agencies", "sdi_code")) payload.sdi_code = parsed.sdi_code;

  return payload;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const parsed = agencyPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati agenzia non validi." }, { status: 400 });
    }

    const payload = await buildAgencyPayload(auth.admin, parsed.data);
    const { data: inserted, error } = await auth.admin.from("agencies").insert({
      tenant_id: auth.membership.tenant_id,
      ...payload,
      active: true
    }).select("id").single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, id: inserted?.id ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const agencyId = typeof body?.agency_id === "string" ? body.agency_id : "";
    if (!agencyId) {
      return NextResponse.json({ error: "Agency ID mancante." }, { status: 400 });
    }

    const parsed = agencyPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati agenzia non validi." }, { status: 400 });
    }

    const payload = await buildAgencyPayload(auth.admin, parsed.data);
    const { error } = await auth.admin
      .from("agencies")
      .update(payload)
      .eq("id", agencyId)
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
    const agencyId = typeof body?.agency_id === "string" ? body.agency_id : "";
    if (!agencyId) {
      return NextResponse.json({ error: "Agency ID mancante." }, { status: 400 });
    }

    const { error } = await auth.admin
      .from("agencies")
      .delete()
      .eq("id", agencyId)
      .eq("tenant_id", auth.membership.tenant_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}
