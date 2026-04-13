/**
 * GET  /api/ops/agency-profile-changes          → lista modifiche pending (operatore)
 * POST /api/ops/agency-profile-changes { action: "approve" | "reject" | "acknowledge" }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    change_id: z.string().uuid()
  }),
  z.object({
    action: z.literal("reject"),
    change_id: z.string().uuid(),
    rejection_note: z.string().min(1, "Inserisci una nota di rifiuto.")
  }),
  z.object({
    action: z.literal("acknowledge"),
    change_id: z.string().uuid()
  })
]);

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("agency_profile_changes")
    .select("id, agency_id, status, changes, rejection_note, acknowledged_at, created_at, agencies(name)")
    .eq("tenant_id", auth.membership.tenant_id)
    .in("status", ["pending", "rejected"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).map((row) => ({
    ...row,
    agency_name: Array.isArray(row.agencies) ? (row.agencies[0] as { name: string } | undefined)?.name ?? null : (row.agencies as { name: string } | null)?.name ?? null
  }));

  return NextResponse.json({ ok: true, rows });
}

export async function POST(request: NextRequest) {
  // Acknowledge può essere chiamato anche da utente agency
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "agency"]);
  if (auth instanceof NextResponse) return auth;

  const body = actionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const { action, change_id } = body.data;

  // Recupera il record
  const { data: changeRow, error: fetchErr } = await auth.admin
    .from("agency_profile_changes")
    .select("id, tenant_id, agency_id, status, changes")
    .eq("id", change_id)
    .eq("tenant_id", auth.membership.tenant_id)
    .maybeSingle();

  if (fetchErr || !changeRow) {
    return NextResponse.json({ error: "Richiesta modifica non trovata." }, { status: 404 });
  }

  if (action === "approve") {
    if (!["admin", "operator", "supervisor"].includes(auth.membership.role as string)) {
      return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
    }
    if (changeRow.status !== "pending") {
      return NextResponse.json({ error: "La richiesta non è in stato pending." }, { status: 409 });
    }

    // Applica le modifiche alla tabella agencies
    const { error: updateErr } = await auth.admin
      .from("agencies")
      .update({ ...(changeRow.changes as Record<string, unknown>), updated_at: new Date().toISOString() })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", changeRow.agency_id);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    await auth.admin
      .from("agency_profile_changes")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .eq("id", change_id);

    return NextResponse.json({ ok: true });
  }

  if (action === "reject") {
    if (!["admin", "operator", "supervisor"].includes(auth.membership.role as string)) {
      return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
    }
    if (changeRow.status !== "pending") {
      return NextResponse.json({ error: "La richiesta non è in stato pending." }, { status: 409 });
    }

    const { rejection_note } = body.data as { action: "reject"; change_id: string; rejection_note: string };
    await auth.admin
      .from("agency_profile_changes")
      .update({ status: "rejected", rejection_note, updated_at: new Date().toISOString() })
      .eq("id", change_id);

    return NextResponse.json({ ok: true });
  }

  if (action === "acknowledge") {
    if (changeRow.status !== "rejected") {
      return NextResponse.json({ error: "La richiesta non è in stato rejected." }, { status: 409 });
    }

    await auth.admin
      .from("agency_profile_changes")
      .update({ acknowledged_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", change_id);

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Azione non riconosciuta." }, { status: 400 });
}
