import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const requestAccessSchema = z.object({
  full_name: z.string().min(2).max(120).trim(),
  requested_role: z.enum(["operator", "driver", "agency"]).optional()
});

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length);
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });

  const parsed = requestAccessSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }
  const { full_name, requested_role } = parsed.data;

  // Check no existing active membership
  const { data: existingMembership } = await admin
    .from("memberships")
    .select("user_id, suspended")
    .eq("user_id", user.id)
    .not("tenant_id", "is", null)
    .maybeSingle();

  if (existingMembership?.user_id) {
    const susp = (existingMembership as { user_id: string; suspended?: boolean }).suspended;
    if (susp === true) return NextResponse.json({ error: "Il tuo accesso è sospeso." }, { status: 403 });
    return NextResponse.json({ error: "Hai già un accesso attivo per questo tenant." }, { status: 409 });
  }

  // Resolve tenant: always use the first active tenant (explicit tenant_id not accepted from clients)
  let tenantId: string | undefined;
  let tenantName: string | null = null;
  const { data: tenants } = await admin
    .from("tenants")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1);
  const firstTenant = (tenants ?? []) as Array<{ id: string; name: string }>;
  tenantId = firstTenant[0]?.id;
  tenantName = firstTenant[0]?.name ?? null;

  if (!tenantId) {
    return NextResponse.json({ error: "Nessun tenant trovato. Contatta l'amministratore." }, { status: 404 });
  }

  // Check no pending request already exists for this tenant. A previously
  // rejected request is reopened (same row, status back to "pending")
  // instead of blocked forever — the unique(tenant_id, user_id) constraint
  // means a plain insert would otherwise 500 on conflict.
  const { data: existingRequest } = await admin
    .from("tenant_access_requests")
    .select("id, status, review_notes, reviewed_by_user_id, reviewed_at")
    .eq("user_id", user.id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (existingRequest?.id && existingRequest.status !== "rejected") {
    return NextResponse.json({
      error: "Hai già una richiesta accesso in attesa. Attendi l'approvazione dell'amministratore."
    }, { status: 409 });
  }

  const requestPersistPayload = {
    tenant_id: tenantId,
    user_id: user.id,
    email: user.email ?? "",
    full_name: full_name.trim(),
    requested_role: requested_role ?? null,
    status: "pending",
    review_notes: null,
    reviewed_by_user_id: null,
    reviewed_at: null
  };

  const { data: newRequest, error: insertErr } = existingRequest?.id
    ? await admin
        .from("tenant_access_requests")
        .update(requestPersistPayload)
        .eq("id", existingRequest.id)
        .select("id, tenant_id, status, created_at")
        .single()
    : await admin
        .from("tenant_access_requests")
        .insert(requestPersistPayload)
        .select("id, tenant_id, status, created_at")
        .single();

  if (insertErr || !newRequest) {
    return NextResponse.json({ error: insertErr?.message ?? "Errore creazione richiesta." }, { status: 500 });
  }

  // Append-only trail: a reopen overwrites review_notes/reviewed_by/reviewed_at
  // on the same row above, so the prior rejection reason is captured here
  // before it becomes unrecoverable — see the analogous log in
  // app/api/auth/register/route.ts.
  await admin
    .from("auth_audit_log")
    .insert({
      user_id: user.id,
      event_type: existingRequest?.id ? "access_request_reopened" : "register",
      status: "success",
      ip_address: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown",
      details: existingRequest?.id
        ? {
            tenant_id: tenantId,
            request_id: existingRequest.id,
            previous_review_notes: existingRequest.review_notes ?? null,
            previous_reviewed_by_user_id: existingRequest.reviewed_by_user_id ?? null,
            previous_reviewed_at: existingRequest.reviewed_at ?? null
          }
        : { tenant_id: tenantId, request_id: newRequest.id, full_name: full_name.trim(), requested_role: requested_role ?? null }
    })
    .then(() => undefined, () => undefined);

  return NextResponse.json({
    ok: true,
    request: { ...(newRequest as object), tenant_name: tenantName }
  }, { status: 201 });
}
