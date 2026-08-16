import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

type AgencyLedgerServiceRow = {
  id: string;
  customer_name: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  booking_service_kind: string | null;
  arrival_date: string | null;
  pax: number | null;
  agency_quoted_price_cents: number | null;
  agency_payment_status: string | null;
  agency_paid_at: string | null;
  agencies: { id: string | null; name: string | null } | { id: string | null; name: string | null }[] | null;
  hotels: { name: string | null } | { name: string | null }[] | null;
};

async function authorize(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user } } = await admin.auth.getUser(authHeader.slice(7));
  if (!user) return null;
  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  const role = parseRole(membership?.role);
  if (!membership?.tenant_id || !role || !["admin", "operator"].includes(role)) return null;
  return { admin, tenantId: membership.tenant_id };
}

/**
 * GET /api/agency/ledger?agency_id=<uuid>
 * Restituisce le voci del libro mastro per un'agenzia, ordinate per data.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const sp = new URL(request.url).searchParams;
  const agencyId = sp.get("agency_id");

  const [agenciesRes, servicesRes] = await Promise.all([
    ctx.admin
      .from("agencies")
      .select("id, name")
      .eq("tenant_id", ctx.tenantId)
      .eq("active", true)
      .order("name"),
    (() => {
      let q = ctx.admin
        .from("services")
        .select("id, customer_name, customer_first_name, customer_last_name, booking_service_kind, arrival_date, pax, agency_quoted_price_cents, agency_payment_status, agency_paid_at, agencies(id, name), hotels(name)")
        .eq("tenant_id", ctx.tenantId)
        .not("agency_quoted_price_cents", "is", null)
        .neq("status", "cancelled")
        .order("arrival_date", { ascending: true }) as any;
      if (agencyId) q = q.eq("agency_id", agencyId);
      else q = q.not("agency_id", "is", null);
      return q.limit(2000);
    })(),
  ]);

  if (servicesRes.error) {
    return NextResponse.json({ error: servicesRes.error.message }, { status: 500 });
  }

  const entries = ((servicesRes.data ?? []) as AgencyLedgerServiceRow[]).map((s) => {
    const isPaid = s.agency_payment_status === "paid";
    const isWaived = s.agency_payment_status === "waived";
    return {
      id: s.id,
      date: s.arrival_date ?? "",
      customer_name: s.customer_first_name && s.customer_last_name
        ? `${s.customer_first_name} ${s.customer_last_name}`
        : (s.customer_name ?? "—"),
      booking_service_kind: s.booking_service_kind ?? null,
      hotel_name: (Array.isArray(s.hotels) ? s.hotels[0] : s.hotels)?.name ?? "—",
      pax: s.pax ?? 1,
      agency_id: (Array.isArray(s.agencies) ? s.agencies[0] : s.agencies)?.id ?? null,
      agency_name: (Array.isArray(s.agencies) ? s.agencies[0] : s.agencies)?.name ?? "—",
      amount_cents: s.agency_quoted_price_cents as number,
      payment_status: s.agency_payment_status as string,
      paid_at: s.agency_paid_at ?? null,
      is_paid: isPaid,
      is_waived: isWaived,
    };
  });

  // Saldo progressivo calcolato in ordine cronologico (oldest → newest)
  let running = 0;
  const withBalance = entries.map((e) => {
    if (!e.is_waived) {
      running += e.amount_cents;         // addebito
      if (e.is_paid) running -= e.amount_cents; // pagamento
    }
    return { ...e, running_balance_cents: running };
  });

  const totalDebit = entries.filter((e) => !e.is_waived).reduce((s, e) => s + e.amount_cents, 0);
  const totalPaid = entries.filter((e) => e.is_paid).reduce((s, e) => s + e.amount_cents, 0);

  return NextResponse.json({
    agencies: agenciesRes.data ?? [],
    entries: withBalance,
    summary: {
      total_debit_cents: totalDebit,
      total_paid_cents: totalPaid,
      outstanding_cents: totalDebit - totalPaid,
    },
  });
}
