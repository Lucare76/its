import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendListeBrunoEmail, type BrunoArrival, type BrunoDeparture } from "@/lib/server/liste-bruno-email";
import { getPickupRule, getPickupRuleByRange, getPickupRuleByIslandPickup } from "@/lib/departure-pickup-rules";

export const runtime = "nodejs";

// Normalizza il nome zona dal DB ("Lacco Ameno", "Forio d'Ischia" ecc.)
// alle chiavi usate nelle regole di prelevamento ("lacco", "forio" ecc.)
function normalizeZona(raw: string): string {
  const z = raw.toLowerCase().trim();
  if (z.includes("forio"))        return "forio";
  if (z.includes("lacco"))        return "lacco";
  if (z.includes("casamicciola")) return "casamicciola";
  if (z.includes("barano"))       return "barano";
  return "ischia"; // "Ischia Porto", "Ischia", oppure zona non impostata
}

// Tempi di percorrenza in minuti in base alla compagnia/porto.
function ferryTravelMinutes(boatCo: string, porto: string): number {
  const co = boatCo.toLowerCase();
  const p  = porto.toLowerCase();
  if (co.includes("alilauro"))                          return 50;
  if (co.includes("snav"))                              return 65;
  if (co.includes("medmar") || p.includes("pozzuoli")) return 60;
  return 95; // traghetto Napoli fallback
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.trim().split(":").map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Partenza dall'isola → arrivo al porto continentale (per partenze, usato da Bruno)
function computeArrivalAtPorto(boatT: string, boatCo: string, porto: string): string {
  return addMinutes(boatT, ferryTravelMinutes(boatCo, porto));
}

// Partenza dal porto continentale → arrivo a Ischia (per arrivi, usato dagli autisti sull'isola)
function computeArrivalAtIschia(vesselField: string): string | null {
  // Il vessel degli arrivi è nel formato "MEDMAR 08:10", "ALILAURO 06:30", ecc.
  const timeMatch = vesselField.match(/(\d{2}:\d{2})/);
  if (!timeMatch) return null;
  const departureTime = timeMatch[1];
  const v = vesselField.toLowerCase();
  const co = v.includes("alilauro") ? "alilauro" : v.includes("snav") ? "snav" : v.includes("medmar") ? "medmar" : "";
  const porto = v.includes("pozzuoli") ? "pozzuoli" : v.includes("napoli") ? "napoli" : "";
  return addMinutes(departureTime, ferryTravelMinutes(co, porto));
}

async function loadBrunoData(auth: ReturnType<typeof authorizePricingRequest> extends Promise<infer T> ? T : never, date: string) {
  // @ts-expect-error auth type resolved at runtime
  const tenantId = auth.membership.tenant_id;

  // Arrivi Bruno: solo aeroporto (non stazione — la stazione è gestita da altri vettori)
  const AIRPORT_KINDS = ["transfer_airport_hotel", "transfer_airport_hotel_aliscafo", "transfer_airport_hotel_exclusive", "transfer_train_hotel_aliscafo"];

  // Partenze Bruno: servizi esclusivi Sosandra aliscafo (volo o treno) + aliscafo aeroporto
  // I trasferimenti standard (non _exclusive, non aliscafo) sono gestiti dal Piano del Giorno con i vettori
  const EXCLUSIVE_KINDS = ["transfer_airport_hotel_exclusive", "transfer_train_hotel_exclusive", "transfer_airport_hotel_aliscafo", "transfer_train_hotel_aliscafo"];

  const [arrivalsRes, departuresRes, settingsRes] = await Promise.all([
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("services")
      .select("id, customer_name, pax, time, vessel, place_type, meeting_point, phone, notes, service_type_code, booking_service_kind, hotels(name)")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("direction", "arrival")
      .eq("is_draft", false)
      .or(`place_type.eq.airport,service_type_code.in.(${AIRPORT_KINDS.join(",")}),booking_service_kind.in.(${AIRPORT_KINDS.join(",")})`)
      .order("time"),
    // @ts-expect-error auth type resolved at runtime
    auth.admin
      .from("services")
      .select("id, customer_name, pax, time, departure_time, vessel, place_type, meeting_point, phone, notes, porto_bruno, service_type_code, booking_service_kind, billing_party_name, hotels(name, zone)")
      .eq("tenant_id", tenantId)
      .eq("is_draft", false)
      // Partenze round-trip: la data rilevante è departure_date (≠ date del servizio principale)
      // Partenze pure: direction=departure e date = data richiesta (senza departure_date separato)
      .or(`departure_date.eq.${date},and(date.eq.${date},direction.eq.departure,departure_date.is.null)`)
      .or(`service_type_code.in.(${EXCLUSIVE_KINDS.join(",")}),booking_service_kind.in.(${EXCLUSIVE_KINDS.join(",")})`)
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
    billing_party_name?: string | null;
    hotels: { name: string; zone?: string | null } | null;
  };

  // Deriva place_type effettivo: usa il campo esplicito se è station/airport,
  // altrimenti lo inferisce dal service_type_code / booking_service_kind
  function resolvePlaceType(r: Row): "station" | "airport" {
    if (r.place_type === "station" || r.place_type === "airport") return r.place_type;
    const kind = r.service_type_code ?? r.booking_service_kind ?? "";
    if (AIRPORT_KINDS.includes(kind)) return "airport";
    return "station"; // tutti gli altri STATION_KINDS
  }

  // Le note che iniziano con [pdf_import] sono metadati interni — non visibili a Bruno
  function cleanNotes(raw: string | null): string {
    if (!raw) return "";
    return raw.includes("[pdf_import]") ? "" : raw;
  }

  const mapArrival = (r: Row): BrunoArrival => ({
    id: r.id,
    customer_name: r.customer_name,
    pax: r.pax,
    time: r.time,
    vessel: r.vessel,
    arrival_at_ischia: computeArrivalAtIschia(r.vessel ?? ""),
    place_type: resolvePlaceType(r),
    meeting_point: r.meeting_point,
    phone: r.phone,
    hotel_name: r.hotels?.name ?? null,
    notes: cleanNotes(r.notes),
  });

  const mapDeparture = (r: Row): BrunoDeparture => {
    // Prova a derivare traghetto e porto dalle regole di prelevamento
    const kind = r.booking_service_kind ?? r.service_type_code ?? "";
    // Se zone non è impostata, usiamo "ischia" come fallback:
    // ferry e porto sono identici per tutte le zone nello stesso slot.
    const zona = normalizeZona(r.hotels?.zone ?? "");
    // Per le liste Bruno NON filtriamo per agenzia: i voli traghetto hanno tutti
    // not_sosandra=true, quindi se billing_party_name="Sosandra" il lookup fallirebbe.
    // Bruno lavora indipendentemente dall'agenzia: usa "" per bypassare il filtro.
    const agencyForLookup = "";
    let computedVessel: string | null = null;
    let computedPorto: string | null = null;
    let computedBoatT: string | null = null;
    let matchedConnectionTime: string | null = null;

    // place_type effettivo come fallback quando booking_service_kind non è impostato
    const effectivePlaceType = resolvePlaceType(r);

    // Candidati per l'orario connessione: proviamo entrambi i campi time.
    // Per servizi puri (direction=departure): r.time = orario volo/treno, r.departure_time = prelievo hotel.
    // Per round-trip (via departure_date): r.departure_time = prelievo hotel, r.time = arrivo isola.
    // Proviamo entrambi: l'orario prelievo hotel (05:15) non cadrà mai in nessuna fascia
    // volo/treno (che partono da 08:30), quindi solo l'orario connessione reale darà match.
    const tFromCandidates = [
      r.departure_time?.slice(0, 5),
      r.time?.slice(0, 5),
    ].filter((t): t is string => Boolean(t));

    const transportTypes: string[] = [];
    if (kind === "transfer_train_hotel") transportTypes.push("treno_traghetto", "treno_aliscafo");
    else if (kind === "transfer_airport_hotel" || kind === "transfer_airport_hotel_aliscafo") transportTypes.push("volo_traghetto", "volo_aliscafo");
    else if (kind === "formula_snav") transportTypes.push("snav");
    else if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli" || kind.startsWith("medmar")) transportTypes.push("medmar");
    // Fallback su place_type se booking_service_kind non è riconosciuto
    if (transportTypes.length === 0) {
      if (effectivePlaceType === "airport") transportTypes.push("volo_traghetto", "volo_aliscafo");
      else if (effectivePlaceType === "station") transportTypes.push("treno_traghetto", "treno_aliscafo");
    }

    let ruleFound = false;
    // Tentativo 1: ricerca in avanti — l'orario nel DB è il volo/treno
    for (const tFrom of tFromCandidates) {
      if (ruleFound) break;
      for (const tt of transportTypes) {
        const rule = getPickupRule(agencyForLookup, tt, tFrom, zona)
          ?? getPickupRuleByRange(agencyForLookup, tt, tFrom, zona);
        if (rule) {
          computedVessel = `${rule.boat_co} ${rule.boat_t}`;
          computedBoatT = rule.boat_t;
          computedPorto = rule.porto_p;
          matchedConnectionTime = tFrom;
          ruleFound = true;
          break;
        }
      }
    }
    // Tentativo 2: ricerca inversa — l'orario nel DB è il pickup sull'isola (05:15 ecc.)
    // In questo caso non abbiamo l'orario volo/treno, lo deriviamo dalla regola trovata.
    if (!ruleFound) {
      for (const tFrom of tFromCandidates) {
        if (ruleFound) break;
        for (const tt of transportTypes) {
          const rule = getPickupRuleByIslandPickup(tt, tFrom, zona);
          if (rule) {
            computedVessel = `${rule.boat_co} ${rule.boat_t}`;
            computedBoatT = rule.boat_t;
            computedPorto = rule.porto_p;
            // connection_time: mostriamo la fascia slot (t_from–t_to) come riferimento
            matchedConnectionTime = rule.t_to ? `${rule.t_from}–${rule.t_to}` : rule.t_from;
            ruleFound = true;
            break;
          }
        }
      }
    }

    // connection_time: orario volo/treno/bus del cliente per Bruno
    // Se abbiamo trovato la regola, matchedConnectionTime è l'orario connessione usato nel lookup.
    // Se non trovata, usiamo il miglior candidato disponibile.
    const connection_time = matchedConnectionTime ?? r.departure_time?.slice(0, 5) ?? r.time?.slice(0, 5) ?? null;

    const porto_bruno = r.porto_bruno || computedPorto || null;
    const arrival_at_porto = computedBoatT && computedVessel
      ? computeArrivalAtPorto(computedBoatT, computedVessel, porto_bruno ?? "")
      : null;

    return {
      id: r.id,
      customer_name: r.customer_name,
      pax: r.pax,
      time: r.departure_time ?? r.time,
      vessel: computedVessel ?? r.vessel,
      boat_t: computedBoatT,
      arrival_at_porto,
      connection_time,
      place_type: resolvePlaceType(r),
      meeting_point: r.meeting_point,
      phone: r.phone,
      porto_bruno,
      hotel_name: r.hotels?.name ?? null,
      notes: cleanNotes(r.notes),
    };
  };

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

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
