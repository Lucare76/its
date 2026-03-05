import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { onboardingDriversBatchSchema } from "@/lib/validation";

export const runtime = "nodejs";

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function POST(request: NextRequest) {
  try {
    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
    }

    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const token = authHeader.slice("Bearer ".length);
    const {
      data: { user },
      error: userError
    } = await admin.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const parsed = onboardingDriversBatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const { data: actorMembership, error: actorMembershipError } = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .eq("tenant_id", parsed.data.tenant_id)
      .maybeSingle();

    if (actorMembershipError || !actorMembership) {
      return NextResponse.json({ error: "Membership non valida." }, { status: 403 });
    }

    if (actorMembership.role !== "admin" && actorMembership.role !== "operator") {
      return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }

    const created: Array<{ email: string; user_id: string }> = [];
    const failed: Array<{ email: string; error: string }> = [];

    for (const driver of parsed.data.drivers) {
      const result = await admin.auth.admin.createUser({
        email: driver.email.trim().toLowerCase(),
        password: driver.password,
        email_confirm: true,
        user_metadata: {
          full_name: driver.full_name
        }
      });

      if (result.error || !result.data.user) {
        failed.push({ email: driver.email, error: result.error?.message ?? "Creazione utente fallita." });
        continue;
      }

      const newUserId = result.data.user.id;
      const { error: membershipError } = await admin.from("memberships").insert({
        user_id: newUserId,
        tenant_id: parsed.data.tenant_id,
        role: "driver",
        full_name: driver.full_name
      });

      if (membershipError) {
        failed.push({ email: driver.email, error: membershipError.message });
        continue;
      }

      created.push({ email: driver.email, user_id: newUserId });
    }

    return NextResponse.json({ created, failed }, { status: 200 });
  } catch (error) {
    console.error("Onboarding drivers POST error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
