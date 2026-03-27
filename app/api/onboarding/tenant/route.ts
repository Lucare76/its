import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { parseRole, type AppCapability } from "@/lib/rbac";
import { onboardingTenantSchema } from "@/lib/validation";

export const runtime = "nodejs";

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function getUserFromAuthHeader(admin: ReturnType<typeof createAdminClient>, request: NextRequest) {
  if (!admin) return { error: NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 }) };
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ error: "Sessione non valida." }, { status: 401 }) };
  }
  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: userError
  } = await admin.auth.getUser(token);
  if (userError || !user) {
    return { error: NextResponse.json({ error: "Sessione non valida." }, { status: 401 }) };
  }
  return { user };
}

export async function GET(request: NextRequest) {
  try {
    const admin = createAdminClient();
    const auth = await getUserFromAuthHeader(admin, request);
    if ("error" in auth) return auth.error;
    const user = auth.user;

    const { data: memberships, error: membershipsError } = await admin!
      .from("memberships")
      .select("tenant_id, role, suspended")
      .eq("user_id", user.id);

    if (membershipsError) {
      return NextResponse.json({ error: membershipsError.message }, { status: 500 });
    }

    if (!memberships || memberships.length === 0) {
      const { data: pendingRequest } = await admin!
        .from("tenant_access_requests")
        .select("id, tenant_id, status, created_at, tenants(name)")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .maybeSingle();
      return NextResponse.json({ hasTenant: false, pending_request: pendingRequest ?? null }, { status: 200 });
    }

    const membershipRows = memberships as Array<{ tenant_id: string | null; role: string | null; suspended?: boolean | null }>;
    const membership =
      membershipRows.find(
        (item) => Boolean(item.tenant_id) && parseRole(item.role ?? undefined) !== null && item.suspended !== true
      ) ?? null;
    if (!membership?.tenant_id) {
      const hasSuspendedMembership = membershipRows.some(
        (item) => Boolean(item.tenant_id) && parseRole(item.role ?? undefined) !== null && item.suspended === true
      );
      if (hasSuspendedMembership) {
        return NextResponse.json({ error: "Accesso sospeso per questo tenant." }, { status: 403 });
      }
      const { data: pendingRequest } = await admin!
        .from("tenant_access_requests")
        .select("id, tenant_id, status, created_at, tenants(name)")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .maybeSingle();
      return NextResponse.json({ hasTenant: false, pending_request: pendingRequest ?? null }, { status: 200 });
    }
    const { data: tenant } = await admin!.from("tenants").select("id, name").eq("id", membership.tenant_id).maybeSingle();
    const resolvedRole = parseRole(membership.role ?? undefined) ?? "admin";
    const { data: capabilityOverrides } = await admin!
      .from("role_capability_overrides")
      .select("capability, enabled")
      .eq("tenant_id", membership.tenant_id)
      .eq("role", resolvedRole);

    const capabilityOverrideMap = Object.fromEntries(
      ((capabilityOverrides ?? []) as Array<{ capability: AppCapability; enabled: boolean }>).map((item) => [item.capability, item.enabled])
    );

    return NextResponse.json(
      {
        hasTenant: true,
        tenant: tenant ?? { id: membership.tenant_id, name: "" },
        role: resolvedRole,
        capability_overrides: capabilityOverrideMap
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Onboarding tenant GET error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = createAdminClient();
    const auth = await getUserFromAuthHeader(admin, request);
    if ("error" in auth) return auth.error;
    const user = auth.user;

    const parsed = onboardingTenantSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const { data: existingMemberships, error: existingMembershipsError } = await admin!
      .from("memberships")
      .select("tenant_id, role, suspended")
      .eq("user_id", user.id);

    if (existingMembershipsError) {
      return NextResponse.json({ error: existingMembershipsError.message }, { status: 500 });
    }

    const membershipRows = (existingMemberships ?? []) as Array<{ tenant_id: string | null; role: string | null; suspended?: boolean | null }>;
    const existingValidMembership =
      membershipRows.find((item) => Boolean(item.tenant_id) && parseRole(item.role ?? undefined) !== null) ?? null;

    if (existingValidMembership?.tenant_id) {
      if (existingValidMembership.suspended === true) {
        return NextResponse.json({ error: "Accesso sospeso per questo tenant." }, { status: 403 });
      }
      const { data: tenant } = await admin!.from("tenants").select("id, name").eq("id", existingValidMembership.tenant_id).maybeSingle();
      return NextResponse.json(
        {
          created: false,
          tenant: tenant ?? { id: existingValidMembership.tenant_id, name: parsed.data.company_name },
          role: parseRole(existingValidMembership.role ?? undefined) ?? "admin"
        },
        { status: 200 }
      );
    }

    const { data: pendingRequest } = await admin!
      .from("tenant_access_requests")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .maybeSingle();

    if (pendingRequest?.id) {
      return NextResponse.json({ error: "Hai gia una richiesta accesso in attesa. Attendi revisione admin." }, { status: 409 });
    }

    const { data: tenant, error: tenantError } = await admin!
      .from("tenants")
      .insert({ name: parsed.data.company_name.trim() })
      .select("id, name")
      .single();

    if (tenantError || !tenant) {
      return NextResponse.json({ error: tenantError?.message ?? "Errore creazione tenant." }, { status: 500 });
    }

    const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : user.email ?? "Admin";
    const { error: membershipInsertError } = await admin!.from("memberships").insert({
      user_id: user.id,
      tenant_id: tenant.id,
      role: "admin",
      full_name: fullName
    });

    if (membershipInsertError) {
      await admin!.from("tenants").delete().eq("id", tenant.id);
      return NextResponse.json({ error: membershipInsertError.message }, { status: 500 });
    }

    return NextResponse.json(
      {
        created: true,
        tenant,
        role: "admin"
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Onboarding tenant POST error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
