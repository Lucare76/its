import { NextRequest, NextResponse } from "next/server";
import { parseRole, type AppCapability } from "@/lib/rbac";
import { ACTIVE_TENANT_COOKIE, getRequestedTenantFromRequest, resolvePreferredMembership } from "@/lib/tenant-preference";
import { onboardingTenantSchema } from "@/lib/validation";
import { createAdminClient } from "@/lib/server/supabase-admin";

export const runtime = "nodejs";

/**
 * Mirrors the bootstrap check enforced server-side in POST below (403 when a
 * tenant already exists). This is purely informational for the client — it
 * lets the UI hide the "Crea nuova azienda" option instead of showing a
 * dead-end that always 403s, without being the actual security boundary.
 */
async function canCreateTenantSystemWide(admin: ReturnType<typeof createAdminClient>) {
  const { count } = await admin.from("tenants").select("id", { count: "exact", head: true });
  return (count ?? 0) === 0;
}

async function findLatestAccessRequestForUser(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data } = await admin
    .from("tenant_access_requests")
    .select("id, tenant_id, status, created_at, review_notes, email, tenants(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function getUserFromAuthHeader(admin: ReturnType<typeof createAdminClient>, request: NextRequest) {
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
      const [latestRequest, canCreateTenant] = await Promise.all([
        findLatestAccessRequestForUser(admin!, user.id),
        canCreateTenantSystemWide(admin!)
      ]);
      return NextResponse.json(
        {
          hasTenant: false,
          pending_request: latestRequest?.status === "pending" ? latestRequest : null,
          rejected_request: latestRequest?.status === "rejected" ? latestRequest : null,
          can_create_tenant: canCreateTenant
        },
        { status: 200 }
      );
    }

    const membershipRows = memberships as Array<{ tenant_id: string | null; role: string | null; suspended?: boolean | null }>;
    const tenantContext = getRequestedTenantFromRequest(request);
    const membership = resolvePreferredMembership(membershipRows, tenantContext.preferredTenantId);
    if (!membership?.tenant_id) {
      const hasSuspendedMembership = membershipRows.some(
        (item) => Boolean(item.tenant_id) && parseRole(item.role ?? undefined) !== null && item.suspended === true
      );
      if (hasSuspendedMembership) {
        return NextResponse.json({ error: "Accesso sospeso per questo tenant." }, { status: 403 });
      }
      const [latestRequest, canCreateTenant] = await Promise.all([
        findLatestAccessRequestForUser(admin!, user.id),
        canCreateTenantSystemWide(admin!)
      ]);
      return NextResponse.json(
        {
          hasTenant: false,
          pending_request: latestRequest?.status === "pending" ? latestRequest : null,
          rejected_request: latestRequest?.status === "rejected" ? latestRequest : null,
          can_create_tenant: canCreateTenant
        },
        { status: 200 }
      );
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

    const response = NextResponse.json(
      {
        hasTenant: true,
        tenant: tenant ?? { id: membership.tenant_id, name: "" },
        role: resolvedRole,
        capability_overrides: capabilityOverrideMap
      },
      { status: 200 }
    );
    response.cookies.set(ACTIVE_TENANT_COOKIE, membership.tenant_id, {
      httpOnly: false,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
    return response;
  } catch (error) {
    console.error("Onboarding tenant GET error", error instanceof Error ? error.message : String(error));
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
    const tenantContext = getRequestedTenantFromRequest(request);
    const existingValidMembership = resolvePreferredMembership(membershipRows, tenantContext.preferredTenantId);

    if (existingValidMembership?.tenant_id) {
      if (existingValidMembership.suspended === true) {
        return NextResponse.json({ error: "Accesso sospeso per questo tenant." }, { status: 403 });
      }
      const { data: tenant } = await admin!.from("tenants").select("id, name").eq("id", existingValidMembership.tenant_id).maybeSingle();
      const response = NextResponse.json(
        {
          created: false,
          tenant: tenant ?? { id: existingValidMembership.tenant_id, name: parsed.data.company_name },
          role: parseRole(existingValidMembership.role ?? undefined) ?? "admin"
        },
        { status: 200 }
      );
      response.cookies.set(ACTIVE_TENANT_COOKIE, existingValidMembership.tenant_id, {
        httpOnly: false,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 24 * 30
      });
      return response;
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

    // Self-service tenant creation is only allowed for genuine first-run
    // bootstrap (no tenant exists yet anywhere in the system). Once at least
    // one tenant exists, a normal authenticated user must go through
    // /api/onboarding/access-request (join an existing tenant, pending
    // admin approval) instead of spinning up a new organization + admin
    // membership on their own.
    const { count: existingTenantCount, error: tenantCountError } = await admin!
      .from("tenants")
      .select("id", { count: "exact", head: true });

    if (tenantCountError) {
      return NextResponse.json({ error: tenantCountError.message }, { status: 500 });
    }

    if ((existingTenantCount ?? 0) > 0) {
      return NextResponse.json(
        { error: "Accesso negato. Richiedi l'accesso a un'agenzia esistente invece di crearne una nuova." },
        { status: 403 }
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

    const response = NextResponse.json(
      {
        created: true,
        tenant,
        role: "admin"
      },
      { status: 201 }
    );
    response.cookies.set(ACTIVE_TENANT_COOKIE, tenant.id, {
      httpOnly: false,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
    return response;
  } catch (error) {
    console.error("Onboarding tenant POST error", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
