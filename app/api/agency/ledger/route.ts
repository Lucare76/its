import { listAll } from "@/lib/server/agency-statements";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

type AccountingRow = {
  id: string;
  penalty_id: string | null;
  arrival_date: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_name: string | null;
  booking_service_kind: string | null;
  hotel_name: string;
  pax: number;
  agency_id: string;
  agency_name: string;
  agency_quoted_price_cents: number;
  agency_paid_amount_cents: number;
  agency_payment_status: string;
  agency_paid_at: string | null;
};

async function authorize(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(
    /^["']|["']$/g,
    "",
  );
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(
    /^["']|["']$/g,
    "",
  );
  if (!url || !key) return null;
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const {
    data: { user },
  } = await admin.auth.getUser(authHeader.slice(7));
  if (!user) return null;
  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  const role = parseRole(membership?.role);
  if (!membership?.tenant_id || !role || !["admin", "operator"].includes(role))
    return null;
  return { admin, tenantId: membership.tenant_id };
}

/**
 * GET /api/agency/ledger?agency_id=<uuid>
 * Restituisce le voci del libro mastro per un'agenzia, ordinate per data.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx)
    return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const sp = new URL(request.url).searchParams;
  const agencyId = sp.get("agency_id");

  const { data: agencies, error: agenciesError } = await ctx.admin
    .from("agencies")
    .select("id,name")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true)
    .order("name");
  if (agenciesError)
    return NextResponse.json(
      { error: "Errore lettura agenzie." },
      { status: 500 },
    );
  try {
    const rows = await listAll<AccountingRow>((from, to) =>
      ctx.admin
        .rpc("agency_accounting_rows", {
          p_tenant_id: ctx.tenantId,
          p_agency_id: agencyId ?? null,
        })
        .range(from, to),
    );
    let running = 0;
    const entries = rows.map((s) => {
      const waived = s.agency_payment_status === "waived",
        paid = Math.min(
          s.agency_quoted_price_cents,
          s.agency_paid_amount_cents,
        );
      if (!waived) running += s.agency_quoted_price_cents - paid;
      return {
        id: s.id,
        penalty_id: s.penalty_id,
        date: s.arrival_date ?? "",
        customer_name:
          [s.customer_first_name, s.customer_last_name]
            .filter(Boolean)
            .join(" ") ||
          s.customer_name ||
          "—",
        booking_service_kind: s.booking_service_kind,
        hotel_name: s.hotel_name,
        pax: s.pax,
        agency_id: s.agency_id,
        agency_name: s.agency_name,
        amount_cents: s.agency_quoted_price_cents,
        paid_cents: paid,
        payment_status: s.agency_payment_status,
        paid_at: s.agency_paid_at,
        is_paid: paid >= s.agency_quoted_price_cents,
        is_waived: waived,
        running_balance_cents: running,
      };
    });
    const totalDebit = entries
        .filter((e) => !e.is_waived)
        .reduce((sum, e) => sum + e.amount_cents, 0),
      totalPaid = entries
        .filter((e) => !e.is_waived)
        .reduce((sum, e) => sum + e.paid_cents, 0);
    return NextResponse.json({
      agencies: agencies ?? [],
      entries,
      summary: {
        total_debit_cents: totalDebit,
        total_paid_cents: totalPaid,
        outstanding_cents: totalDebit - totalPaid,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Impossibile leggere il libro mastro." },
      { status: 503 },
    );
  }
}
