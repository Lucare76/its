import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";

export type PricingAuthContext = {
  admin: any;
  user: { id: string };
  membership: { tenant_id: string; role: string; suspended?: boolean };
};

export async function authorizePricingRequest(
  request: NextRequest,
  roles: string[] = ["admin", "operator"]
): Promise<PricingAuthContext | NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = request.headers.get("authorization");
  if (!supabaseUrl || !serviceRoleKey) {
    auditLog({ event: "auth_config_missing", level: "error", details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
  }
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: userError
  } = await admin.auth.getUser(token);
  if (userError || !user) {
    auditLog({ event: "auth_invalid_session", level: "warn", details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
  }

  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role, suspended")
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError || !membership?.tenant_id) {
    auditLog({ event: "auth_membership_missing", level: "warn", userId: user.id, details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
  }
  if (!roles.includes(membership.role)) {
    auditLog({
      event: "auth_role_denied",
      level: "warn",
      tenantId: membership.tenant_id,
      userId: user.id,
      role: membership.role,
      details: { route: request.nextUrl.pathname, allowed_roles: roles }
    });
    return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
  }

  if (membership.suspended === true) {
    auditLog({
      event: "auth_membership_suspended",
      level: "warn",
      tenantId: membership.tenant_id,
      userId: user.id,
      role: membership.role,
      details: { route: request.nextUrl.pathname }
    });
    return NextResponse.json({ error: "Accesso sospeso per questo tenant." }, { status: 403 });
  }

  return {
    admin,
    user: { id: user.id },
    membership: { tenant_id: membership.tenant_id, role: membership.role, suspended: membership.suspended ?? false }
  };
}
