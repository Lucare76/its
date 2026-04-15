import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendListeBrunoEmail, type BrunoArrival, type BrunoDeparture } from "@/lib/server/liste-bruno-email";

export const runtime = "nodejs";

async function loadBrunoData(auth: ReturnType<typeof authorizePricingRequest> extends Promise<infer T> ? T : never, date: string) {
  // @ts-expect-error auth type resolved at runtime
  const tenantId = auth.membership.tenant_id;

  // Tipi di servizio aeroporto/stazione — usati come fallback quando place_type non è esplicitato
  const AIRPORT_KINDS = ["transfer_airport_hotel"];
  const STATION_KINDS = ["transfer_station_hotel", "transfer_train_hotel"];
  const STATION_AIRPORT_KINDS = [...AIRPORT_KINDS, ...STATION_KINDS];

  const [arrivalsRes, departuresRes, settingsRes] = await Promise.all([
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("services")
      .select("id, customer_name, pax, time, vessel, place_type, meeting_point, phone, notes, service_type_code, booking_service_kind, hotels(name)")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("direction", "arrival")
      .eq("is_draft", false)
      .or(`place_type.in.(station,airport),service_type_code.in.(${STATION_AIRPORT_KINDS.join(",")}),booking_service_kind.in.(${STATION_AIRPORT_KINDS.join(",")})`)
      .order("time"),
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("services")
      .select("id, customer_name, pax, time, departure_time, vessel, place_type, meeting_point, phone, notes, porto_bruno, service_type_code, booking_service_kind, hotels(name)")
      .eq("tenant_id", tenantId)
      .eq("is_draft", false)
      // Partenze round-trip: la data rilevante è departure_date (≠ date del servizio principale)
      // Partenze pure: direction=departure e date = data richiesta (senza departure_date separato)
      .or(`departure_date.eq.${date},and(date.eq.${date},direction.eq.departure,departure_date.is.null)`)
      .or(`place_type.in.(station,airport),service_type_code.in.(${STATION_AIRPORT_KINDS.join(",")}),booking_service_kind.in.(${STATION_AIRPORT_KINDS.join(",")})`)
      .order("vessel")
      .order("departure_time"),
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
    departure_time?: string | null;
    vessel: string; place_type: string; meeting_point: string | null;
    phone: string; notes: string; porto_bruno?: string | null;
    service_type_code?: string | null; booking_service_kind?: string | null;
    hotels: { name: string } | null;
  };

  // Deriva place_type effettivo: usa il campo esplicito se è station/airport,
  // altrimenti lo inferisce dal service_type_code / booking_service_kind
  function resolvePlaceType(r: Row): "station" | "airport" {
    if (r.place_type === "station" || r.place_type === "airport") return r.place_type;
    const kind = r.service_type_code ?? r.booking_service_kind ?? "";
    if (AIRPORT_KINDS.includes(kind)) return "airport";
    return "station"; // tutti gli altri STATION_KINDS
  }

  const mapArrival = (r: Row): BrunoArrival => ({
    id: r.id,
    customer_name: r.customer_name,
    pax: r.pax,
    time: r.time,
    vessel: r.vessel,
    place_type: resolvePlaceType(r),
    meeting_point: r.meeting_point,
    phone: r.phone,
    hotel_name: r.hotels?.name ?? null,
    notes: r.notes ?? "",
  });

  const mapDeparture = (r: Row): BrunoDeparture => ({
    id: r.id,
    customer_name: r.customer_name,
    pax: r.pax,
    time: r.departure_time ?? r.time,
    vessel: r.vessel,
    place_type: resolvePlaceType(r),
    meeting_point: r.meeting_point,
    phone: r.phone,
    porto_bruno: r.porto_bruno ?? null,
    hotel_name: r.hotels?.name ?? null,
    notes: r.notes ?? "",
  });

  return {
    arrivals: ((arrivalsRes.data ?? []) as Row[]).map(mapArrival),
    departures: ((departuresRes.data ?? []) as Row[]).map(mapDeparture),
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
      const { service_id, place_type, meeting_point, porto_bruno } = body as {
        service_id: string;
        place_type: "hotel" | "station" | "airport";
        meeting_point?: string;
        porto_bruno?: string;
      };

      const patch: Record<string, unknown> = { place_type };
      if (meeting_point !== undefined) patch.meeting_point = meeting_point?.trim() || null;
      if (porto_bruno !== undefined) patch.porto_bruno = porto_bruno?.trim() || null;

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
