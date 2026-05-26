/**
 * POST /api/ops/driver-profiles/[id]/create-access
 *   Crea un account Supabase Auth + membership per un autista che non ha ancora accesso.
 *   Usato dalla schermata Disponibilità per linkare autisti "Senza accesso utente".
 *
 *   Body: { phone: string }
 *   Response: { ok, username, temporaryPassword, created }
 *     - created=true  → account creato ex-novo
 *     - created=false → account già esisteva, restituisce credenziali
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ensureDriverAccessForProfile } from "@/lib/server/driver-registry";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const { id: profileId } = await params;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const phone = String(body.phone ?? "").trim();

    if (!phone || phone.replace(/\D/g, "").length < 6) {
      return NextResponse.json(
        { ok: false, error: "Numero di telefono non valido. Inserisci almeno 6 cifre." },
        { status: 400 }
      );
    }

    // Verifica che il profilo appartenga al tenant
    const profileRes = await auth.admin
      .from("driver_profiles")
      .select("id, full_name, phone, user_id, active")
      .eq("tenant_id", tenantId)
      .eq("id", profileId)
      .maybeSingle();

    if (profileRes.error) throw new Error(profileRes.error.message);
    if (!profileRes.data?.id) {
      return NextResponse.json({ ok: false, error: "Profilo autista non trovato." }, { status: 404 });
    }
    if (!profileRes.data.active) {
      return NextResponse.json({ ok: false, error: "Profilo autista disattivato." }, { status: 409 });
    }

    // Salva il telefono nel profilo se non presente
    if (!profileRes.data.phone && phone) {
      await auth.admin
        .from("driver_profiles")
        .update({ phone })
        .eq("tenant_id", tenantId)
        .eq("id", profileId);
    }

    const result = await ensureDriverAccessForProfile(auth.admin, {
      tenantId,
      profileId,
      fullName: profileRes.data.full_name,
      phone,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore creazione accesso" },
      { status: 500 }
    );
  }
}
