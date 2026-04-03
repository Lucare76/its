import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendListeBrunoEmail, type BrunoArrival, type BrunoDeparture } from "@/lib/server/liste-bruno-email";

export const runtime = "nodejs";

async function loadBrunoData(auth: ReturnType<typeof authorizePricingRequest> extends Promise<infer T> ? T : never, date: string) {
  // @ts-expect-error auth type resolved at runtime
  const tenantId = auth.membership.tenant_id;

  const [arrivalsRes, departuresRes, settingsRes] = await Promise.all([
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("services")
      .select("id, customer_name, pax, time, vessel, place_type, meeting_point, phone, notes, hotels(name)")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("direction", "arrival")
      .eq("is_draft", false)
      .in("place_type", ["station", "airport"])
      .order("time"),
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("services")
      .select("id, customer_name, pax, time, vessel, place_type, meeting_point, phone, notes, hotels(name)")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("direction", "departure")
      .eq("is_draft", false)
      .in("place_type", ["station", "airport"])
      .order("vessel")
      .order("time"),
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("tenant_operational_settings")
      .select("bruno_email")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  ]);

  if (arrivalsRes.error) throw new Error(arrivalsRes.error.message);
  if (departuresRes.error) throw new Error(departuresRes.error.message);

  type Row = {
    id: string; customer_name: string; pax: number; time: string;
    vessel: string; place_type: string; meeting_point: string | null;
    phone: string; notes: string;
    hotels: { name: string } | null;
  };

  const mapRow = (r: Row): BrunoArrival | BrunoDeparture => ({
    id: r.id,
    customer_name: r.customer_name,
    pax: r.pax,
    time: r.time,
    vessel: r.vessel,
    place_type: r.place_type as "station" | "airport",
    meeting_point: r.meeting_point,
    phone: r.phone,
    hotel_name: r.hotels?.name ?? null,
    notes: r.notes ?? "",
  });

  return {
    arrivals: ((arrivalsRes.data ?? []) as Row[]).map(mapRow) as BrunoArrival[],
    departures: ((departuresRes.data ?? []) as Row[]).map(mapRow) as BrunoDeparture[],
    brunoEmail: settingsRes.data?.bruno_email ?? null,
  };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const data = await loadBrunoData(auth, date);

    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
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
    const date = (body.date as string) ?? new Date().toISOString().slice(0, 10);

    // ── send_email: invia lista a Bruno ───────────────────────────────────
    if (action === "send_email") {
      const { bruno_email, sender_note } = body as { bruno_email: string; sender_note?: string };
      if (!bruno_email?.trim())
        return NextResponse.json({ ok: false, error: "Email di Bruno mancante" }, { status: 400 });

      const data = await loadBrunoData(auth, date);

      const result = await sendListeBrunoEmail({
        date,
        arrivals: data.arrivals,
        departures: data.departures,
        brunoEmail: bruno_email.trim(),
        senderNote: sender_note?.trim() || undefined,
      });

      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // ── save_bruno_email: salva email Bruno nelle impostazioni ────────────
    if (action === "save_bruno_email") {
      const { bruno_email } = body as { bruno_email: string };

      const { error } = await auth.admin
        .from("tenant_operational_settings")
        .upsert({ tenant_id: tenantId, bruno_email: bruno_email?.trim() || null }, { onConflict: "tenant_id" });

      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    // ── set_place_type: aggiorna place_type di un servizio ────────────────
    if (action === "set_place_type") {
      const { service_id, place_type, meeting_point } = body as {
        service_id: string;
        place_type: "hotel" | "station" | "airport";
        meeting_point?: string;
      };

      const patch: Record<string, unknown> = { place_type };
      if (meeting_point !== undefined) patch.meeting_point = meeting_point?.trim() || null;

      const { error } = await auth.admin
        .from("services")
        .update(patch)
        .eq("id", service_id)
        .eq("tenant_id", tenantId);

      if (error) throw new Error(error.message);

      const data = await loadBrunoData(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
