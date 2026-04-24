import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendListeBrunoEmail, type BrunoArrival, type BrunoDeparture } from "@/lib/server/liste-bruno-email";
import {
  loadContinentDispatchServices,
  resetContinentDispatchTarget,
  setContinentDispatchTarget,
} from "@/lib/server/continent-dispatch";

export const runtime = "nodejs";

async function loadBrunoData(auth: ReturnType<typeof authorizePricingRequest> extends Promise<infer T> ? T : never, date: string) {
  const data = await loadContinentDispatchServices(
    // @ts-expect-error auth type resolved at runtime
    auth,
    date
  );

  return {
    arrivals: data.arrivals
      .filter((service) => service.effective_target === "bruno")
      .map((service) => ({
        id: service.id,
        customer_name: service.customer_name,
        pax: service.pax,
        time: service.time,
        vessel: service.vessel,
        arrival_at_ischia: service.arrival_at_ischia,
        place_type: service.place_type,
        meeting_point: service.meeting_point,
        phone: service.phone,
        hotel_name: service.hotel_name,
        notes: service.notes,
        flight_number: service.train_arrival_number,
        dispatch_source: service.target_source,
      })),
    departures: data.departures
      .filter((service) => service.effective_target === "bruno")
      .map((service) => ({
        id: service.id,
        customer_name: service.customer_name,
        pax: service.pax,
        time: service.time,
        vessel: service.vessel,
        boat_t: service.boat_t,
        arrival_at_porto: service.arrival_at_porto,
        connection_time: service.connection_time,
        place_type: service.place_type,
        meeting_point: service.meeting_point,
        phone: service.phone,
        porto_bruno: service.porto_bruno,
        hotel_name: service.hotel_name,
        notes: service.notes,
        flight_number: service.train_departure_number,
        dispatch_source: service.target_source,
      })),
    brunoEmail: data.brunoEmail,
  };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const date = req.nextUrl.searchParams.get("date")?.trim() || new Date().toISOString().slice(0, 10);
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
    const date = ((body.date as string) ?? "").trim() || new Date().toISOString().slice(0, 10);

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

    // ── search_services: cerca servizi per nome cliente (per aggiunte manuali) ──
    if (action === "search_services") {
      const { query } = body as { query: string };
      if (!query || query.trim().length < 2) return NextResponse.json({ ok: true, results: [] });

      const { data, error } = await auth.admin
        .from("services")
        .select("id, customer_name, pax, date, time, departure_date, departure_time, vessel, place_type, booking_service_kind, hotels(name)")
        .eq("tenant_id", tenantId)
        .eq("is_draft", false)
        .neq("status", "cancelled")
        .ilike("customer_name", `%${query.trim()}%`)
        .order("date", { ascending: false })
        .limit(10);

      if (error) throw new Error(error.message);

      type SearchRow = { id: string; customer_name: string; pax: number; date: string; time: string; departure_date: string | null; departure_time: string | null; vessel: string; place_type: string; booking_service_kind: string | null; hotels: { name: string } | { name: string }[] | null };
      const results = ((data ?? []) as unknown as SearchRow[]).map((r) => {
        const hotel = Array.isArray(r.hotels) ? r.hotels[0] ?? null : r.hotels;
        return ({
        id: r.id,
        customer_name: r.customer_name,
        pax: r.pax,
        date: r.date,
        time: r.time.slice(0, 5),
        departure_date: r.departure_date ?? null,
        departure_time: r.departure_time ? r.departure_time.slice(0, 5) : null,
        vessel: r.vessel,
        place_type: r.place_type,
        booking_service_kind: r.booking_service_kind,
        hotel_name: hotel?.name ?? null,
      });
      });

      return NextResponse.json({ ok: true, results });
    }

    // ── set_place_type: aggiorna place_type di un servizio ────────────────
    if (action === "set_place_type") {
      const { service_id, place_type, meeting_point, porto_bruno, vessel } = body as {
        service_id: string;
        place_type: "hotel" | "station" | "airport";
        meeting_point?: string;
        porto_bruno?: string;
        vessel?: string;
      };

      const patch: Record<string, unknown> = { place_type };
      if (meeting_point !== undefined) patch.meeting_point = meeting_point?.trim() || null;
      if (porto_bruno !== undefined) patch.porto_bruno = porto_bruno?.trim() || null;
      if (vessel !== undefined && vessel?.trim()) patch.vessel = vessel.trim();

      const { error } = await auth.admin
        .from("services")
        .update(patch)
        .eq("id", service_id)
        .eq("tenant_id", tenantId);

      if (error) throw new Error(error.message);

      const data = await loadBrunoData(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    if (action === "set_dispatch_target") {
      const { service_id, target, reason } = body as {
        service_id: string;
        target: "bruno" | "continent_dispatch";
        reason?: string;
      };
      if (target !== "bruno" && target !== "continent_dispatch") {
        return NextResponse.json({ ok: false, error: "Target non valido" }, { status: 400 });
      }
      await setContinentDispatchTarget(auth, {
        serviceId: service_id,
        target,
        reason: reason ?? null,
      });
      const data = await loadBrunoData(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    if (action === "reset_dispatch_target") {
      const { service_id } = body as { service_id: string };
      await resetContinentDispatchTarget(auth, service_id);
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
