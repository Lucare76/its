import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function makeAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ── GET — lista autisti con stato account ─────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const [profilesRes, membershipsRes] = await Promise.all([
      auth.admin
        .from("driver_profiles")
        .select("id,full_name,phone")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("full_name"),
      auth.admin
        .from("memberships")
        .select("user_id,full_name")
        .eq("tenant_id", tenantId)
        .eq("role", "driver"),
    ]);

    const profiles = (profilesRes.data ?? []) as Array<{ id: string; full_name: string; phone: string | null }>;
    const memberships = (membershipsRes.data ?? []) as Array<{ user_id: string; full_name: string }>;

    const membershipByName = new Map(memberships.map((m) => [m.full_name.toLowerCase().trim(), m]));

    const drivers = profiles.map((p) => {
      const match = membershipByName.get(p.full_name.toLowerCase().trim());
      return {
        profile_id: p.id,
        full_name: p.full_name,
        phone: p.phone ?? null,
        user_id: match?.user_id ?? null,
        has_account: !!match,
      };
    });

    return NextResponse.json({ ok: true, drivers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;

    // ── Crea account driver ───────────────────────────────────────────────────
    if (action === "create_driver_account") {
      const profileId = body.driver_profile_id as string;
      const email = (body.email as string | undefined)?.trim().toLowerCase();
      const phone = (body.phone as string | undefined)?.trim() ?? "";

      if (!profileId || !email) {
        return NextResponse.json({ ok: false, error: "driver_profile_id e email richiesti" }, { status: 400 });
      }

      const { data: profile, error: profileErr } = await auth.admin
        .from("driver_profiles")
        .select("id,full_name")
        .eq("id", profileId)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (profileErr || !profile) {
        return NextResponse.json({ ok: false, error: "Profilo autista non trovato" }, { status: 404 });
      }

      const adminClient = makeAdminClient();
      if (!adminClient) {
        return NextResponse.json({ ok: false, error: "Configurazione server mancante" }, { status: 500 });
      }

      // Password = telefono (fallback generico)
      const password = phone.replace(/\s/g, "") || "Ischia2025!";

      const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: (profile as { id: string; full_name: string }).full_name,
          force_password_change: true,
        },
      });

      if (createErr || !newUser.user) {
        return NextResponse.json(
          { ok: false, error: createErr?.message ?? "Creazione utente fallita" },
          { status: 500 }
        );
      }

      const { error: membershipErr } = await adminClient.from("memberships").insert({
        user_id: newUser.user.id,
        tenant_id: tenantId,
        role: "driver",
        full_name: (profile as { id: string; full_name: string }).full_name,
      });

      if (membershipErr) {
        await adminClient.auth.admin.deleteUser(newUser.user.id);
        return NextResponse.json({ ok: false, error: membershipErr.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, user_id: newUser.user.id });
    }

    // ── Assegna autista al gruppo bus ─────────────────────────────────────────
    if (action === "assign_driver") {
      const serviceIds = body.service_ids as string[];
      const driverUserId = body.driver_user_id as string;
      const vehicleLabel = body.vehicle_label as string;

      if (!serviceIds?.length || !driverUserId || !vehicleLabel) {
        return NextResponse.json(
          { ok: false, error: "service_ids, driver_user_id e vehicle_label richiesti" },
          { status: 400 }
        );
      }

      // Rimuovi assignments precedenti per questi servizi
      await auth.admin
        .from("assignments")
        .delete()
        .in("service_id", serviceIds)
        .eq("tenant_id", tenantId);

      // Inserisci nuovi assignments
      const { error: insertErr } = await auth.admin.from("assignments").insert(
        serviceIds.map((sid) => ({
          tenant_id: tenantId,
          service_id: sid,
          driver_user_id: driverUserId,
          vehicle_label: vehicleLabel,
        }))
      );

      if (insertErr) throw new Error(insertErr.message);
      return NextResponse.json({ ok: true });
    }

    // ── Rimuovi autista dal gruppo bus ────────────────────────────────────────
    if (action === "remove_driver") {
      const serviceIds = body.service_ids as string[];
      if (!serviceIds?.length) {
        return NextResponse.json({ ok: false, error: "service_ids richiesti" }, { status: 400 });
      }

      await auth.admin
        .from("assignments")
        .delete()
        .in("service_id", serviceIds)
        .eq("tenant_id", tenantId);

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Azione non valida" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
