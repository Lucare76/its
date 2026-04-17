/**
 * GET /api/ops/modification-requests
 * Lista richieste di modifica pendenti per admin/operator.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = auth as any;
    const tenantId = a.membership.tenant_id as string;
    const admin    = a.admin;

    const { data, error } = await admin
      .from("modification_requests")
      .select(`
        id, status, changes, original_values, operator_notes, created_at, updated_at,
        resolved_at,
        services(
          id, customer_name, pax, date, booking_service_kind,
          arrival_date, arrival_time, departure_date, departure_time,
          hotels(id, name),
          agencies(name)
        )
      `)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    // Risolvi nomi richiedenti
    const userIds = [...new Set(
      (data ?? []).map((r: Record<string, unknown>) => r.requested_by_user_id).filter(Boolean)
    )] as string[];
    const nameById: Record<string, string> = {};
    if (userIds.length) {
      const { data: members } = await admin
        .from("memberships")
        .select("user_id, full_name")
        .eq("tenant_id", tenantId)
        .in("user_id", userIds);
      for (const m of members ?? []) nameById[m.user_id] = m.full_name ?? "";
    }

    const requests = (data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      requested_by_name: r.requested_by_user_id
        ? (nameById[r.requested_by_user_id as string] ?? null)
        : null,
    }));

    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
