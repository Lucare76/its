import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { adminUserCreateSchema } from "@/lib/validation";

export const runtime = "nodejs";

type TenantMembershipRow = {
  user_id: string;
  tenant_id: string;
  role: "admin" | "operator" | "driver" | "agency";
  full_name: string;
  created_at?: string | null;
};

async function requireAdminMembership(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { error: NextResponse.json({ error: "Server env missing" }, { status: 500 }) };
  }

  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: authError
  } = await admin.auth.getUser(token);
  if (authError || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role, full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError || !membership?.tenant_id) {
    return { error: NextResponse.json({ error: "Tenant not found" }, { status: 404 }) };
  }

  if (membership.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { admin, membership, actorUserId: user.id };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.admin
    .from("memberships")
    .select("user_id, tenant_id, role, full_name, created_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to load users" }, { status: 500 });
  }

  const memberships = ((data ?? []) as TenantMembershipRow[]).map((item) => ({
    user_id: item.user_id,
    tenant_id: item.tenant_id,
    role: item.role,
    full_name: item.full_name,
    created_at: item.created_at ?? null
  }));

  return NextResponse.json({ ok: true, memberships });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const parsed = adminUserCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const fullName = parsed.data.full_name.trim();

  const existingMembership = await auth.admin
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", auth.membership.tenant_id)
    .ilike("full_name", fullName)
    .limit(1)
    .maybeSingle();

  if (existingMembership.error) {
    return NextResponse.json({ error: "Failed to validate user uniqueness" }, { status: 500 });
  }

  if (existingMembership.data?.user_id) {
    return NextResponse.json({ error: "Esiste gia un utente con questo nome nel tenant." }, { status: 409 });
  }

  const userResult = await auth.admin.auth.admin.createUser({
    email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName
    }
  });

  if (userResult.error || !userResult.data.user) {
    return NextResponse.json({ error: userResult.error?.message ?? "Creazione utente fallita." }, { status: 400 });
  }

  const newUserId = userResult.data.user.id;
  const membershipInsert = await auth.admin.from("memberships").insert({
    user_id: newUserId,
    tenant_id: auth.membership.tenant_id,
    role: parsed.data.role,
    full_name: fullName
  });

  if (membershipInsert.error) {
    await auth.admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
    return NextResponse.json({ error: membershipInsert.error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      ok: true,
      user: {
        user_id: newUserId,
        tenant_id: auth.membership.tenant_id,
        role: parsed.data.role,
        full_name: fullName,
        email
      }
    },
    { status: 201 }
  );
}
