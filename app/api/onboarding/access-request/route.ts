import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const requestAccessSchema = z.object({
  full_name: z.string().min(2).max(120).trim(),
  requested_role: z.enum(["operator", "driver", "agency"]).optional(),
  tenant_id: z.string().uuid().optional()
});

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  const { full_name, requested_role, tenant_id: explicitTenantId } = parsed.data;

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

  // Resolve tenant: use explicit ID, or find the first active tenant
  let tenantId = explicitTenantId;
  let tenantName: string | null = null;
  if (!tenantId) {
    const { data: tenants } = await admin
      .from("tenants")
      .select("id, name")
      .order("created_at", { ascending: true })
      .limit(1);
    const firstTenant = (tenants ?? []) as Array<{ id: string; name: string }>;
    tenantId = firstTenant[0]?.id;
    tenantName = firstTenant[0]?.name ?? null;
  } else {
    const { data: tenantRow } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    tenantName = (tenantRow as { name?: string } | null)?.name ?? null;
  }

  if (!tenantId) {
    return NextResponse.json({ error: "Nessun tenant trovato. Contatta l'amministratore." }, { status: 404 });
  }

  // Check no pending request already exists for this tenant
  const { data: existingRequest } = await admin
    .from("tenant_access_requests")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (existingRequest?.id) {
    return NextResponse.json({
      error: "Hai già una richiesta accesso in attesa. Attendi l'approvazione dell'amministratore."
    }, { status: 409 });
  }

  const { data: newRequest, error: insertErr } = await admin
    .from("tenant_access_requests")
    .insert({
      tenant_id: tenantId,
      user_id: user.id,
      email: user.email ?? "",
      full_name: full_name.trim(),
      requested_role: requested_role ?? null,
      status: "pending"
    })
    .select("id, tenant_id, status, created_at")
    .single();

  if (insertErr || !newRequest) {
    return NextResponse.json({ error: insertErr?.message ?? "Errore creazione richiesta." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    request: { ...(newRequest as object), tenant_name: tenantName }
  }, { status: 201 });
}
