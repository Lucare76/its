import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

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
 * GET /api/agency/statement?agency_id=<uuid>
 * Ritorna tutti i servizi con prezzo dichiarato per il tenant,
 * opzionalmente filtrati per agenzia.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const url = new URL(request.url);
  const agencyId = url.searchParams.get("agency_id");

  // Agenzie del tenant
  const { data: agencies } = await ctx.admin
    .from("agencies")
    .select("id, name")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true)
    .order("name");

  // Servizi con prezzo dichiarato
  const baseQuery = () =>
    ctx.admin
      .from("services")
      .select("id, customer_name, customer_first_name, customer_last_name, booking_service_kind, arrival_date, departure_date, pax, status, approval_status, agency_quoted_price_cents, agency_payment_status, agency_paid_at, created_at, hotels(name), agencies(id, name)")
      .eq("tenant_id", ctx.tenantId)
      .not("agency_quoted_price_cents", "is", null)
      .neq("status", "cancelled")
      .order("arrival_date", { ascending: false });

  // TS2589 fix: the previous `let q = ...; q = q.eq(...) / q = q.not(...)`
  // pattern forced TypeScript to reconcile two differently-narrowed
  // PostgrestFilterBuilder chain types (one per branch) against a single
  // mutable variable, on top of the already-deep type produced by the
  // embedded-resource select string (hotels(name), agencies(id, name)) —
  // that reassignment/union-narrowing is what blew past the instantiation
  // depth limit. Building the two fully-resolved branches independently
  // (each awaited/destructured on its own) avoids the reassignment
  // narrowing entirely; runtime behavior is unchanged (same filters, same
  // final query per branch).
  const { data: services, error } = agencyId
    ? await baseQuery().eq("agency_id", agencyId).limit(1000)
    : await baseQuery().not("agency_id", "is", null).limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (services ?? []).map((s) => ({
    ...s,
    hotel_name: (Array.isArray(s.hotels) ? s.hotels[0] : s.hotels)?.name ?? "—",
    agency_id: (Array.isArray(s.agencies) ? s.agencies[0] : s.agencies)?.id ?? null,
    agency_name: (Array.isArray(s.agencies) ? s.agencies[0] : s.agencies)?.name ?? "—",
  }));

  return NextResponse.json({ rows, agencies: agencies ?? [] });
}
