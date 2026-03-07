import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
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
      .select("tenant_id, role")
      .eq("user_id", user.id);

    if (membershipsError) {
      return NextResponse.json({ error: membershipsError.message }, { status: 500 });
    }

    if (!memberships || memberships.length === 0) {
      return NextResponse.json({ hasTenant: false }, { status: 200 });
    }

    const membership = memberships[0] as { tenant_id: string; role: string };
    const { data: tenant } = await admin!.from("tenants").select("id, name").eq("id", membership.tenant_id).maybeSingle();

    return NextResponse.json(
      {
        hasTenant: true,
        tenant: tenant ?? { id: membership.tenant_id, name: "" },
        role: membership.role
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
      .select("tenant_id, role")
      .eq("user_id", user.id);

    if (existingMembershipsError) {
      return NextResponse.json({ error: existingMembershipsError.message }, { status: 500 });
    }

    if (existingMemberships && existingMemberships.length > 0) {
      const membership = existingMemberships[0] as { tenant_id: string; role: string };
      const { data: tenant } = await admin!.from("tenants").select("id, name").eq("id", membership.tenant_id).maybeSingle();
      return NextResponse.json(
        {
          created: false,
          tenant: tenant ?? { id: membership.tenant_id, name: parsed.data.company_name },
          role: membership.role
        },
        { status: 200 }
      );
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
