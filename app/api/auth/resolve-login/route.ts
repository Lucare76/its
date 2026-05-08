import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function membershipsSupportUsername(admin: NonNullable<ReturnType<typeof createAdminClient>>) {
  const result = await admin.from("memberships").select("username").limit(1);
  if (!result.error) return true;
  if ((result.error as { code?: string }).code === "42703") return false;
  throw new Error(result.error.message);
}

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { identifier?: string } | null;
  const identifier = body?.identifier?.trim() ?? "";
  if (!identifier) {
    return NextResponse.json({ error: "Identificativo mancante." }, { status: 400 });
  }

  if (identifier.includes("@")) {
    return NextResponse.json({ ok: true, email: identifier.toLowerCase(), username: null });
  }

  const hasUsernameColumn = await membershipsSupportUsername(admin);
  if (!hasUsernameColumn) {
    return NextResponse.json(
      { error: "Login con username non disponibile finché non viene applicata la migrazione utenti driver." },
      { status: 409 }
    );
  }

  const membershipResult = await admin
    .from("memberships")
    .select("user_id, username")
    .eq("username", identifier.toLowerCase())
    .maybeSingle();

  if (membershipResult.error) {
    return NextResponse.json({ error: membershipResult.error.message }, { status: 500 });
  }
  if (!membershipResult.data?.user_id) {
    return NextResponse.json({ error: "Username non trovato." }, { status: 404 });
  }

  const userResult = await admin.auth.admin.getUserById(membershipResult.data.user_id);
  const email = userResult.data.user?.email?.trim().toLowerCase() ?? null;
  if (userResult.error || !email) {
    return NextResponse.json({ error: userResult.error?.message ?? "Email login non disponibile." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    email,
    username: membershipResult.data.username ?? identifier.toLowerCase(),
  });
}
