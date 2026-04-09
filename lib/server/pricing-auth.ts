import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { resolvePreferredMembership } from "@/lib/tenant-preference";

type BaseMembershipRow = {
  tenant_id: string;
  role: string;
  suspended?: boolean | null;
};

export type AuthorizedRequestContext<TRole extends string = string, TExtra extends object = {}> = {
  admin: SupabaseClient;
  user: { id: string; email: string | null };
  membership: { tenant_id: string; role: TRole; suspended: boolean } & TExtra;
};

type AuthorizeRequestOptions<TRole extends string, TExtra extends object> = {
  roles: readonly TRole[];
  membershipFields?: Array<keyof TExtra | "tenant_id" | "role" | "suspended">;
  auditPrefix?: string;
  allowSuspended?: boolean;
};

export type PricingAuthContext = AuthorizedRequestContext<string>;

export async function authorizeServiceRoleRequest<TRole extends string, TExtra extends object = {}>(
  request: NextRequest,
  options: AuthorizeRequestOptions<TRole, TExtra>
): Promise<AuthorizedRequestContext<TRole, TExtra> | NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = request.headers.get("authorization");
  const auditPrefix = options.auditPrefix ?? "auth";
  if (!supabaseUrl || !serviceRoleKey) {
    auditLog({ event: `${auditPrefix}_config_missing`, level: "error", details: { route: request.nextUrl.pathname } });
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
    auditLog({ event: `${auditPrefix}_invalid_session`, level: "warn", details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
  }

  const requestedFields = Array.from(new Set(["tenant_id", "role", "suspended", ...(options.membershipFields ?? [])]));
  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select(requestedFields.join(", "))
    .eq("user_id", user.id);
  const membershipRows = (memberships ?? []) as unknown as Array<BaseMembershipRow & TExtra>;
  const membership = resolvePreferredMembership(membershipRows);
  if (membershipError || !membership?.tenant_id) {
    auditLog({ event: `${auditPrefix}_membership_missing`, level: "warn", userId: user.id, details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
  }
  const allowedRoles = options.roles.includes("admin" as TRole) && !options.roles.includes("supervisor" as TRole)
    ? [...options.roles, "supervisor" as TRole]
    : options.roles;
  if (!allowedRoles.includes(membership.role as TRole)) {
    auditLog({
      event: `${auditPrefix}_role_denied`,
      level: "warn",
      tenantId: membership.tenant_id,
      userId: user.id,
      role: membership.role,
      details: { route: request.nextUrl.pathname, allowed_roles: allowedRoles }
    });
    return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
  }

  if (membership.suspended === true && !options.allowSuspended) {
    auditLog({
      event: `${auditPrefix}_membership_suspended`,
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
    user: { id: user.id, email: user.email ?? null },
    membership: {
      ...(membership as TExtra & BaseMembershipRow),
      tenant_id: membership.tenant_id,
      role: membership.role as TRole,
      suspended: membership.suspended ?? false
    }
  };
}

export async function authorizePricingRequest(
  request: NextRequest,
  roles: string[] = ["admin", "operator", "supervisor"]
): Promise<PricingAuthContext | NextResponse> {
  return authorizeServiceRoleRequest(request, {
    roles,
    auditPrefix: "auth"
  });
}
