/**
 * POST /api/pdf/claude-save-draft
 *
 * Riceve il form compilato dall'operatore (dopo estrazione Claude) e crea
 * un servizio confermato in inbound_emails + services.
 * Il servizio appare subito in Arrivi e Partenze.
 *
 * Body: { form: FormState, pdf_base64?: string, filename?: string, agency?: string }
 * Protetto: admin / operator.
 */

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { canonicalizeKnownHotelName, normalizeHotelAliasValue } from "@/lib/server/hotel-aliases";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { buildDuplicateProbe, lookupBookingDuplicates, hydrateDuplicateMatches } from "@/lib/server/agency-pdf-import";
import { resolveIncomingFerryMeta } from "@/lib/server/ferry-connection-lookup";
import { auditLog } from "@/lib/server/ops-audit";
import { logServiceChange, readServiceSnapshot } from "@/lib/server/service-audit-log";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// ─── Tipi ──────────────────────────────────────────────────────────────────

type FormState = {
  cliente_nome: string;
  cliente_cellulare: string;
  n_pax: string;
  hotel: string;
  data_arrivo: string;
  orario_arrivo: string;
  data_partenza: string;
  orario_partenza: string;
  tipo_servizio: string;
  treno_andata: string;
  treno_ritorno: string;
  citta_partenza: string;
  totale_pratica: string;
  note: string;
  numero_pratica: string;
  agenzia: string;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const IT_MONTHS: Record<string, string> = {
  gen: "01", feb: "02", mar: "03", apr: "04", mag: "05", giu: "06",
  lug: "07", ago: "08", set: "09", ott: "10", nov: "11", dic: "12",
  gennaio: "01", febbraio: "02", marzo: "03", aprile: "04", maggio: "05",
  giugno: "06", luglio: "07", agosto: "08", settembre: "09", ottobre: "10",
  novembre: "11", dicembre: "12"
};

function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const dmyAbbr = s.match(/^(\d{1,2})[-\s]([a-zA-Zàèéùì]+)[-\s](\d{2,4})$/i);
  if (dmyAbbr) {
    const month = IT_MONTHS[dmyAbbr[2].toLowerCase()];
    if (month) {
      const year = dmyAbbr[3].length === 2 ? `20${dmyAbbr[3]}` : dmyAbbr[3];
      return `${year}-${month}-${dmyAbbr[1].padStart(2, "0")}`;
    }
  }
  const longIt = s.match(/^(\d{1,2})\s+([a-zA-Zàèéùì]+)\s+(\d{4})$/i);
  if (longIt) {
    const month = IT_MONTHS[longIt[2].toLowerCase()];
    if (month) return `${longIt[3]}-${month}-${longIt[1].padStart(2, "0")}`;
  }
  return null;
}

function normalizeTime(raw: string | null | undefined): string | null {
  const match = String(raw ?? "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function clean(v: string | null | undefined): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

function slug(v: string | null | undefined) {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function hashString(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

function normCity(c: string) {
  return c.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

async function tryAutoAllocateBus(
  admin: SupabaseClient,
  tenantId: string,
  serviceId: string,
  familyCode: string,
  canonicalCity: string | null,
  pax: number,
  arrivalDate: string,
  departureDate: string | null,
  userId: string | null
): Promise<{ allocated: boolean; unit_label?: string; reason?: string }> {
  // 1. Trova la linea bus del tenant con questo family code
  const { data: lines } = await admin
    .from("tenant_bus_lines")
    .select("id, code, name")
    .eq("tenant_id", tenantId)
    .eq("family_code", familyCode)
    .eq("active", true)
    .limit(1);
  if (!lines?.length) return { allocated: false, reason: "nessuna linea bus configurata per " + familyCode };

  const lineId = lines[0].id as string;

  // 2. Trova i bus unit aperti per questa linea
  const { data: units } = await admin
    .from("tenant_bus_units")
    .select("id, label, capacity, status, manual_close, sort_order")
    .eq("bus_line_id", lineId)
    .eq("active", true)
    .eq("manual_close", false)
    .neq("status", "closed")
    .neq("status", "completed")
    .order("sort_order");
  if (!units?.length) return { allocated: false, reason: "nessun bus disponibile" };

  // 3. Conta i pax già allocati su questa data per ciascun unit
  const unitIds = (units as Array<{ id: string }>).map((u) => u.id);
  const { data: allocations } = await admin
    .from("tenant_bus_allocations")
    .select("bus_unit_id, pax_assigned, direction, services!inner(date)")
    .in("bus_unit_id", unitIds)
    .eq("services.date", arrivalDate)
    .eq("direction", "arrival");

  const usedByUnit = new Map<string, number>();
  for (const a of (allocations ?? []) as Array<{ bus_unit_id: string; pax_assigned: number }>) {
    usedByUnit.set(a.bus_unit_id, (usedByUnit.get(a.bus_unit_id) ?? 0) + a.pax_assigned);
  }

  // 4. Scegli il bus con più posti liberi che può ospitare i pax
  const bestUnit = (units as Array<{ id: string; label: string; capacity: number }>)
    .map((u) => ({ ...u, remaining: u.capacity - (usedByUnit.get(u.id) ?? 0) }))
    .filter((u) => u.remaining >= pax)
    .sort((a, b) => b.remaining - a.remaining)[0];
  if (!bestUnit) return { allocated: false, reason: "nessun bus con posti sufficienti" };

  // 5. Trova la fermata di andata nel DB
  const { data: arrivalStops } = await admin
    .from("tenant_bus_line_stops")
    .select("id, stop_name, city")
    .eq("bus_line_id", lineId)
    .eq("direction", "arrival")
    .eq("active", true);

  const targetCity = normCity(canonicalCity ?? "");

  // Match esatto prima, poi substring — evita che "ROMA" vinca su "ROMA TIBURTINA"
  function findStop(stops: Array<{ id: string; stop_name: string; city: string }>) {
    if (!canonicalCity) return null;
    const list = stops as Array<{ id: string; stop_name: string; city: string }>;
    // 1. match esatto
    const exact = list.find((s) => normCity(s.city) === targetCity);
    if (exact) return exact;
    // 2. il candidato più specifico (città più lunga) che contiene il target o viceversa
    const fuzzy = list
      .filter((s) => {
        const c = normCity(s.city);
        return c.includes(targetCity) || targetCity.includes(c);
      })
      .sort((a, b) => normCity(b.city).length - normCity(a.city).length);
    return fuzzy[0] ?? null;
  }

  const arrivalStop = findStop(arrivalStops ?? []);

  if (!arrivalStop) return { allocated: false, reason: "fermata andata non trovata per " + (canonicalCity ?? "N/D") };

  // 6. Alloca andata
  const { error: errArr } = await admin.rpc("allocate_bus_service", {
    p_tenant_id: tenantId,
    p_service_id: serviceId,
    p_bus_line_id: lineId,
    p_bus_unit_id: bestUnit.id,
    p_stop_id: arrivalStop.id,
    p_stop_name: arrivalStop.stop_name,
    p_direction: "arrival",
    p_pax_assigned: pax,
    p_notes: "Auto-assegnato da import PDF",
    p_created_by_user_id: userId
  });
  if (errArr) return { allocated: false, reason: "errore allocazione andata: " + errArr.message };

  // 7. Alloca ritorno se c'è data di partenza
  if (departureDate) {
    // Cerca fermate direzione "departure", con fallback a "arrival" (stesse città)
    const { data: departureStops } = await admin
      .from("tenant_bus_line_stops")
      .select("id, stop_name, city")
      .eq("bus_line_id", lineId)
      .eq("direction", "departure")
      .eq("active", true);

    const departureStop = findStop(departureStops ?? [])
      ?? findStop(arrivalStops ?? []); // fallback: stesse fermate andata (stessa città, direzione opposta)

    if (departureStop) {
      const { error: errDep } = await admin.rpc("allocate_bus_service", {
        p_tenant_id: tenantId,
        p_service_id: serviceId,
        p_bus_line_id: lineId,
        p_bus_unit_id: bestUnit.id,
        p_stop_id: departureStop.id,
        p_stop_name: departureStop.stop_name,
        p_direction: "departure",
        p_pax_assigned: pax,
        p_notes: "Auto-assegnato da import PDF",
        p_created_by_user_id: userId
      });
      if (errDep) {
        console.warn("[auto-alloc] errore allocazione ritorno:", errDep.message);
      }
    } else {
      console.warn("[auto-alloc] fermata ritorno non trovata per:", canonicalCity);
    }
  }

  return { allocated: true, unit_label: bestUnit.label };
}

function tipoToBookingKind(tipo: string): { bookingKind: string; transportMode: string } {
  if (tipo === "transfer_airport_hotel") return { bookingKind: "transfer_airport_hotel", transportMode: "unknown" };
  if (tipo === "transfer_port_hotel") return { bookingKind: "transfer_port_hotel", transportMode: "hydrofoil" };
  if (tipo === "bus_city_hotel") return { bookingKind: "bus_city_hotel", transportMode: "bus" };
  if (tipo === "excursion") return { bookingKind: "excursion", transportMode: "bus" };
  return { bookingKind: "transfer_train_hotel", transportMode: "train" };
}

// Valori ammessi dal constraint services_service_type_code_valid (vedi
// supabase/migrations/0021/0024/0030_*.sql). form.tipo_servizio usa già
// questi stessi valori per ogni kind tranne "bus_city_hotel", che sul lato
// service_type_code si chiama "bus_line".
const VALID_SERVICE_TYPE_CODES = new Set([
  "transfer_station_hotel",
  "transfer_airport_hotel",
  "transfer_port_hotel",
  "transfer_hotel_port",
  "excursion",
  "ferry_transfer",
  "bus_line",
]);

function toServiceTypeCode(tipo: string | null | undefined): string | null {
  const raw = clean(tipo);
  if (!raw) return null;
  if (raw === "bus_city_hotel") return "bus_line";
  return VALID_SERVICE_TYPE_CODES.has(raw) ? raw : null;
}

async function resolveOrCreateHotel(admin: SupabaseClient, tenantId: string, hotelName: string | null) {
  const rawName = clean(hotelName);
  const name = canonicalizeKnownHotelName(rawName) ?? rawName ?? "Hotel da verificare";
  const normalizedName = name.toLowerCase();
  const { data: hotels } = await admin.from("hotels").select("id, name").eq("tenant_id", tenantId).limit(500);
  const { data: aliases } = await admin.from("hotel_aliases").select("hotel_id, alias").eq("tenant_id", tenantId).limit(5000);
  const list = (hotels ?? []) as Array<{ id: string; name: string }>;
  const aliasList = (aliases ?? []) as Array<{ hotel_id: string; alias: string }>;
  const matched =
    list.find((h) => h.name.toLowerCase() === normalizedName) ??
    list.find((h) => h.name.toLowerCase().includes(normalizedName)) ??
    list.find((h) => normalizedName.includes(h.name.toLowerCase())) ??
    aliasList.find((alias) => normalizeHotelAliasValue(alias.alias) === normalizeHotelAliasValue(name))?.hotel_id;
  if (typeof matched === "string") return matched;
  if (matched?.id) return matched.id;
  const { data: created } = await admin
    .from("hotels")
    .insert({ tenant_id: tenantId, name, normalized_name: slug(name), address: "Ischia", city: "Ischia", zone: "Ischia Porto", lat: 40.7405, lng: 13.9438, source: "claude_pdf_import", is_active: true })
    .select("id").single();
  const createdId = (created as { id: string } | null)?.id ?? null;
  if (createdId && rawName && normalizeHotelAliasValue(rawName) !== normalizeHotelAliasValue(name)) {
    await admin.from("hotel_aliases").insert({
      tenant_id: tenantId,
      hotel_id: createdId,
      alias: rawName,
      alias_normalized: normalizeHotelAliasValue(rawName),
      source: "auto_import"
    });
  }
  return createdId;
}

// ─── Route ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

  let body: {
    form?: FormState;
    pdf_base64?: string;
    filename?: string;
    agency?: string;
    force?: boolean;
    /** Decisione esplicita dal pannello duplicati (vedi inbox-approve). */
    action?: "update_existing" | "create_new";
    /** Service esistente scelto per "update_existing" (ri-validato server-side). */
    existing_service_id?: string;
  };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  const { form, pdf_base64, filename = "upload.pdf", agency = "unknown" } = body;
  const force = body.force === true || body.action === "create_new";
  const updateExistingId = body.action === "update_existing" ? clean(body.existing_service_id) : null;
  if (!form) return NextResponse.json({ ok: false, error: "Dati form mancanti." }, { status: 400 });

  // ── Validazione campi obbligatori ─────────────────────────────────────────
  const arrivalDate = parseDate(form.data_arrivo);
  if (!arrivalDate) return NextResponse.json({ ok: false, error: "Data arrivo non valida. Usa formato 2026-04-19 oppure 19-apr-26." }, { status: 422 });
  if (!clean(form.cliente_nome)) return NextResponse.json({ ok: false, error: "Nome cliente obbligatorio." }, { status: 422 });
  if (!clean(form.hotel)) return NextResponse.json({ ok: false, error: "Hotel obbligatorio." }, { status: 422 });

  const departureDate = parseDate(form.data_partenza);
  const returnTime = normalizeTime(form.orario_partenza);
  const customerName = clean(form.cliente_nome) ?? "Cliente da verificare";
  const hotelName = clean(form.hotel);
  const practiceNumber = clean(form.numero_pratica);
  const trainArrivalNumber = clean(form.treno_andata);
  const trainDepartureNumber = clean(form.treno_ritorno);
  const arrivalPlace = clean(form.citta_partenza);
  const passengers = Math.max(1, Math.min(99, Number(form.n_pax) || 1));
  const totalAmount = form.totale_pratica ? parseFloat(form.totale_pratica.replace(",", ".")) : null;
  const sourceTotalCents = totalAmount && isFinite(totalAmount) ? Math.round(totalAmount * 100) : null;
  const sourcePricePerPaxCents = sourceTotalCents && passengers > 0 ? Math.round(sourceTotalCents / passengers) : null;

  const { bookingKind, transportMode } = tipoToBookingKind(form.tipo_servizio ?? "transfer_station_hotel");
  const isTrainKind = bookingKind === "transfer_train_hotel";
  const serviceTypeCode = toServiceTypeCode(form.tipo_servizio);
  // Regola condivisa insert/update: se ci sono entrambi i numeri treno, li
  // combina "andata / ritorno"; altrimenti il singolo disponibile; altrimenti
  // null (fallback preesistente per i kind non-bus, mai valorizzato prima).
  const transportCode = trainArrivalNumber && trainDepartureNumber
    ? `${trainArrivalNumber} / ${trainDepartureNumber}`
    : trainArrivalNumber ?? trainDepartureNumber ?? null;

  // Per servizi bus: risoluzione bidirezionale della fermata (città o indirizzo pickupNote)
  const resolvedBusStop = bookingKind === "bus_city_hotel" ? resolveBusStop(arrivalPlace) : null;

  // Orario andata: dal form; se assente nei bus, prende l'orario dal catalogo fermate
  const outboundTime = normalizeTime(form.orario_arrivo) ?? (bookingKind === "bus_city_hotel" ? (resolvedBusStop?.time ?? null) : null);
  const canonicalBusCity = resolvedBusStop?.canonicalCity ?? arrivalPlace;
  const busPickupNote = resolvedBusStop?.pickupNote ?? null;
  const busLineCode = resolvedBusStop?.lineCode ?? null;
  const busLineName = resolvedBusStop?.lineName ?? null;
  const busFamilyCode = resolvedBusStop?.familyCode ?? null;
  const busFamilyName = resolvedBusStop?.familyName ?? null;
  // Per i servizi bus l'orario è opzionale (spesso non presente nel PDF)
  if (!outboundTime && bookingKind !== "bus_city_hotel") {
    return NextResponse.json(
      { ok: false, error: "Orario arrivo non valido o mancante. Inserisci un orario reale nel formato HH:MM prima di salvare." },
      { status: 422 }
    );
  }

  // ── AGGIORNA PRENOTAZIONE ESISTENTE ─────────────────────────────────────
  // Stessa semantica di app/api/email/inbox-approve/route.ts: il server non si
  // fida dell'ID del client, riesegue il deduplicatore e aggiorna in-place
  // (stesso ID, relazioni intatte) i soli campi realmente cambiati.
  if (updateExistingId) {
    const probe = buildDuplicateProbe({
      practiceNumber,
      customerName,
      phone: clean(form.cliente_cellulare),
      arrivalDate,
      hotelName,
    });
    const { certain_service_id, matches } = await lookupBookingDuplicates(admin, tenantId, probe);
    const allowed = new Set<string>(
      [certain_service_id, ...matches.map((m) => m.service_id)].filter((x): x is string => Boolean(x))
    );
    if (!allowed.has(updateExistingId)) {
      auditLog({
        event: "inbox_duplicate_resolution",
        level: "warn",
        tenantId,
        userId,
        role: auth.membership.role,
        serviceId: updateExistingId,
        duplicate: true,
        outcome: "update_existing_rejected",
        details: { reason: "service_not_in_matches", channel: "pdf_upload" },
      });
      return NextResponse.json(
        { ok: false, error: "La prenotazione da aggiornare non corrisponde a nessuno dei duplicati rilevati per questo import." },
        { status: 422 }
      );
    }

    const before = await readServiceSnapshot(auth, tenantId, updateExistingId);
    if (!before) {
      return NextResponse.json({ ok: false, error: "Prenotazione esistente non trovata." }, { status: 404 });
    }

    const patch: Record<string, unknown> = {};
    const setIfChanged = (col: string, value: string | number | null | undefined) => {
      if (value === null || value === undefined || value === "") return;
      const current = (before as Record<string, unknown>)[col] ?? null;
      if (JSON.stringify(current) === JSON.stringify(value)) return;
      patch[col] = value;
    };
    setIfChanged("customer_name", customerName);
    setIfChanged("phone", clean(form.cliente_cellulare));
    setIfChanged("pax", passengers);
    setIfChanged("time", outboundTime);
    setIfChanged("outbound_time", outboundTime);
    setIfChanged("arrival_time", outboundTime);
    setIfChanged("return_time", returnTime);
    setIfChanged("departure_time", returnTime);
    setIfChanged("arrival_date", arrivalDate);
    if (before.direction === "arrival") setIfChanged("date", arrivalDate);
    setIfChanged("departure_date", departureDate);
    setIfChanged("meeting_point", arrivalPlace);
    setIfChanged("transport_code", transportCode);
    setIfChanged("service_type_code", serviceTypeCode);
    if (isTrainKind) {
      setIfChanged("train_arrival_number", trainArrivalNumber);
      setIfChanged("train_arrival_time", outboundTime);
      setIfChanged("train_departure_number", trainDepartureNumber);
      setIfChanged("train_departure_time", returnTime);
    }
    setIfChanged("source_total_amount_cents", sourceTotalCents);
    setIfChanged("source_price_per_pax_cents", sourcePricePerPaxCents);

    if (hotelName) {
      const newHotelId = await resolveOrCreateHotel(auth.admin, tenantId, hotelName);
      if (newHotelId && newHotelId !== before.hotel_id) patch.hotel_id = newHotelId;
    }

    const currentNotes = typeof before.notes === "string" ? before.notes : "";
    if (practiceNumber) {
      const nextNotes = /\[practice:[^\]]+\]/.test(currentNotes)
        ? currentNotes.replace(/\[practice:[^\]]+\]/, `[practice:${practiceNumber}]`)
        : `${currentNotes}${currentNotes ? " | " : ""}[practice:${practiceNumber}]`;
      if (nextNotes !== currentNotes) patch.notes = nextNotes;
    }

    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await admin
        .from("services")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", updateExistingId);
      if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
    }

    const after = await readServiceSnapshot(auth, tenantId, updateExistingId);
    await logServiceChange({
      auth,
      tenantId,
      serviceId: updateExistingId,
      rootServiceId: updateExistingId,
      before,
      after,
      fields: Object.keys(patch),
    });
    auditLog({
      event: "inbox_duplicate_resolution",
      tenantId,
      userId,
      role: auth.membership.role,
      serviceId: updateExistingId,
      duplicate: true,
      outcome: "update_existing",
      details: { existing_service_id: updateExistingId, changed_fields: Object.keys(patch), channel: "pdf_upload" },
    });

    return NextResponse.json({
      ok: true,
      updated: true,
      draft_service_id: updateExistingId,
      changed_fields: Object.keys(patch),
    });
  }

  // ── Hash / dedupe ─────────────────────────────────────────────────────────
  const pdfHash = pdf_base64
    ? createHash("sha256").update(Buffer.from(pdf_base64, "base64")).digest("hex").slice(0, 24)
    : hashString(JSON.stringify(form)).slice(0, 24);
  const textHash = hashString(JSON.stringify(form)).slice(0, 24);
  const compositeKey = slug(`${customerName}|${arrivalDate}|${hotelName ?? "hotel-nd"}`);
  const dedupeKey = hashString([practiceNumber, customerName, arrivalDate, hotelName, textHash].filter(Boolean).join("|")).slice(0, 24);
  const externalReference = practiceNumber ?? compositeKey;

  // ── Controllo idempotenza STESSO FILE ────────────────────────────────────
  // pdf_hash = stesso identico PDF già importato. Resta invariato.
  if (!force) {
    const { data: dupService } = await admin
      .from("services")
      .select("id, customer_name, date")
      .eq("tenant_id", tenantId)
      .ilike("notes", `%[pdf_hash:${pdfHash}]%`)
      .maybeSingle();
    if (dupService?.id) {
      return NextResponse.json({
        ok: false,
        duplicate: true,
        existing_service_id: dupService.id,
        error: `Questo PDF è già stato importato (${dupService.customer_name} — ${dupService.date}). Vuoi salvarlo comunque?`
      }, { status: 409 });
    }
  }

  // ── Controllo STESSA PRENOTAZIONE (deduplicatore condiviso) ──────────────
  // Diverso dal pdf_hash: qui intercettiamo la stessa prenotazione arrivata da
  // un altro canale (pratica / telefono / nome / [pdf_composite]). Riusa
  // lib/server/agency-pdf-import.ts. `force:true` = "AGGIUNGI COMUNQUE".
  if (!force) {
    const probe = buildDuplicateProbe({
      practiceNumber,
      customerName,
      phone: clean(form.cliente_cellulare),
      arrivalDate,
      hotelName,
    });
    const { certain_service_id, matches } = await lookupBookingDuplicates(admin, tenantId, probe);
    if (matches.length > 0) {
      const hydrated = await hydrateDuplicateMatches(admin, tenantId, matches);
      // Preview canonica (PARTE 3, audit 26/010806): stesso helper server di
      // GET /api/ops/services/[id], mai un resolver ferry nel client. hotel_id
      // best-effort dal match trovato (se già a sistema) — se assente resta
      // comunque valutabile una regola generale, mai una zona indovinata.
      const incoming_ferry_meta = await resolveIncomingFerryMeta(admin, {
        bookingServiceKind: bookingKind,
        arrivalDate,
        arrivalTime: outboundTime,
        departureDate,
        departureTime: returnTime,
        hotelId: hydrated[0]?.hotel_id ?? null,
        agencyName: form.agenzia,
        pax: passengers,
      });
      return NextResponse.json(
        {
          ok: false,
          duplicate: true,
          certain_service_id: certain_service_id ?? null,
          matches: hydrated,
          incoming_ferry_meta,
        },
        { status: 409 }
      );
    }
  }

  const normalizedForJson = {
    parser_key: `claude_${agency}`,
    parser_score: 0.95,
    parsing_quality: "high",
    agency_name: form.agenzia,
    billing_party_name: form.agenzia,
    external_reference: externalReference,
    service_type: form.tipo_servizio,
    service_variant: form.tipo_servizio === "transfer_station_hotel" ? "train_station_hotel" : null,
    transport_mode: transportMode,
    booking_kind: bookingKind,
    customer_full_name: customerName,
    customer_phone: clean(form.cliente_cellulare) ?? "N/D",
    arrival_date: arrivalDate,
    outbound_time: outboundTime,
    departure_date: departureDate,
    return_time: returnTime,
    arrival_place: arrivalPlace,
    hotel_or_destination: hotelName,
    passengers,
    train_arrival_number: trainArrivalNumber,
    train_departure_number: trainDepartureNumber,
    source_total_amount_cents: sourceTotalCents,
    source_price_per_pax_cents: sourcePricePerPaxCents,
    source_amount_currency: "EUR",
    notes: clean(form.note) ?? "",
    dedupe_components: { practice_number: practiceNumber, customer_name: customerName, arrival_date: arrivalDate, hotel: hotelName, pdf_hash: pdfHash, text_hash: textHash, composite_key: compositeKey },
    parser_logs: [`Claude AI (claude-sonnet-4-6)`, `Agenzia: ${agency}`, `Verificato e salvato dall'operatore`]
  };

  const bodyText = `Import PDF Claude AI. Agenzia: ${form.agenzia}. Cliente: ${customerName}. Pratica: ${practiceNumber ?? "N/D"}.`;

  const parsedJson = {
    source: "claude-ai-extraction",
    from_email: "operator@manual-upload.local",
    subject: `Import Claude AI: ${filename}`,
    received_at: new Date().toISOString(),
    review_status: "ready_operational",
    attachments: [{ filename, mime_type: "application/pdf", has_content: false }],
    pdf_parser: { key: `claude_${agency}`, mode: "dedicated", score: 0.95, selection_confidence: "high", selection_reason: `Claude AI — agenzia ${agency} — verificato operatore` },
    pdf_import: {
      import_mode: "final",
      import_state: "imported",
      parser_key: `claude_${agency}`,
      parsing_quality: "high",
      fields_found: ["customer_full_name", "customer_phone", "arrival_date", "hotel_or_destination", "passengers"],
      missing_fields: [],
      parser_logs: normalizedForJson.parser_logs,
      dedupe: { key: dedupeKey, external_reference: externalReference, ...normalizedForJson.dedupe_components },
      original_normalized: normalizedForJson,
      normalized: normalizedForJson,
      effective_normalized: normalizedForJson,
      reviewed_values: null,
      has_manual_review: true,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      linked_service_id: null,
      possible_existing_matches: []
    }
  };

  // ── Inserisci inbound_email ───────────────────────────────────────────────
  const { data: inboundEmail, error: inboundError } = await admin
    .from("inbound_emails")
    .insert({
      tenant_id: tenantId,
      from_email: "operator@manual-upload.local",
      subject: `Import Claude AI: ${filename}`,
      raw_text: bodyText,
      body_text: bodyText,
      extracted_text: JSON.stringify(form, null, 2),
      parsed_json: parsedJson,
      created_at: new Date().toISOString()
    })
    .select("id").single();

  if (inboundError || !inboundEmail?.id) {
    return NextResponse.json({ ok: false, error: inboundError?.message ?? "Errore inserimento." }, { status: 500 });
  }

  // ── Risolvi / crea hotel ──────────────────────────────────────────────────
  const hotelId = await resolveOrCreateHotel(auth.admin, tenantId, hotelName);
  if (!hotelId) return NextResponse.json({ ok: false, error: "Hotel non trovato e non creabile." }, { status: 500 });

  // ── Pickup hotel per transfer_port_hotel puri (SNAV/MEDMAR diretti) ──────
  // Stessa logica canonica di app/api/email/inbox-approve/route.ts — via
  // applyPickupCalc (lib/server/apply-pickup-calc.ts), MAI una regex locale
  // parallela. Fuori da questo scenario (es. "HOTEL PICKUP ORE HH:MM" nelle
  // note di un transfer treno/hotel) non esiste una funzione di dominio che
  // estragga pickup_hotel/pickup_time/pickup_alert da testo libero: il
  // valore resta nelle notes, invariato, come oggi.
  let pickupHotel: string | null = null;
  let pickupAlert: string | null = null;
  if (bookingKind === "transfer_port_hotel" && returnTime) {
    const { data: hotelZoneRow } = await auth.admin.from("hotels").select("zone").eq("id", hotelId).maybeSingle();
    const zoneRaw = (hotelZoneRow as { zone?: string | null } | null)?.zone ?? null;
    const pickupFields = applyPickupCalc({
      direction: "departure",
      booking_service_kind: bookingKind,
      time: returnTime,
      billing_party_name: form.agenzia,
      vessel: trainDepartureNumber ?? trainArrivalNumber ?? null,
      hotel_zone: zoneRaw,
      hotel_name: hotelName ?? null,
    });
    pickupHotel = pickupFields.pickup_hotel ?? null;
    pickupAlert = pickupFields.pickup_alert ?? null;
  }

  // ── Note servizio ─────────────────────────────────────────────────────────
  const notesParts = [
    "[pdf_import] Booking finale creato da PDF",
    `[source:claude_${agency}]`,
    `[import_mode:final]`,
    `[import_state:imported]`,
    `[manual_review:true]`,
    `[imported_from_pdf_preview:true]`,
    `[parser:claude_${agency}]`,
    `[parsing_quality:high]`,
    `[billing_party_name:${form.agenzia}]`,
    practiceNumber ? `[practice:${practiceNumber}]` : null,
    `[pdf_hash:${pdfHash}]`,
    `[pdf_text_hash:${textHash}]`,
    `[pdf_dedupe:${dedupeKey}]`,
    `[pdf_composite:${compositeKey}]`,
    trainArrivalNumber ? `[train_arrival_number:${trainArrivalNumber}]` : null,
    trainDepartureNumber ? `[train_departure_number:${trainDepartureNumber}]` : null,
    bookingKind !== "bus_city_hotel" && arrivalPlace ? `pickup/porto: ${arrivalPlace}` : null,
    busLineCode ? `[bus_line_suggested:${busLineCode}]` : null,
    busFamilyCode ? `[bus_family:${busFamilyCode}]` : null,
    hotelName ? `hotel/destinazione: ${hotelName}` : null,
    clean(form.note)
  ].filter(Boolean).join(" | ");

  // ── Crea servizio confermato ──────────────────────────────────────────────
  const { data: service, error: serviceError } = await admin
    .from("services")
    .insert({
      tenant_id: tenantId,
      inbound_email_id: inboundEmail.id,
      is_draft: false,
      date: arrivalDate,
      time: outboundTime,
      service_type: "transfer",
      direction: "arrival",
      vessel: bookingKind === "transfer_port_hotel"
        ? (trainArrivalNumber ?? arrivalPlace ?? "MEDMAR")
        : bookingKind === "bus_city_hotel"
        ? (canonicalBusCity ?? "Bus da verificare")
        : (arrivalPlace ?? "Transfer da PDF"),
      meeting_point: bookingKind === "bus_city_hotel" ? (busPickupNote ?? canonicalBusCity) : arrivalPlace,
      bus_city_origin: bookingKind === "bus_city_hotel" ? (canonicalBusCity ?? null) : null,
      transport_code: bookingKind === "bus_city_hotel" ? (busFamilyCode ?? null) : transportCode,
      pax: passengers,
      hotel_id: hotelId,
      customer_name: customerName,
      billing_party_name: form.agenzia,
      outbound_time: outboundTime,
      return_time: returnTime,
      // Campi operativi strutturati letti dalla card/edit prenotazione (stessa
      // ragione/parita' di app/api/email/inbox-approve/route.ts): senza questi,
      // arrival_date/arrival_time/departure_time restano NULL anche quando il
      // parser li ha estratti correttamente, e la card mostra "—".
      arrival_date: arrivalDate,
      arrival_time: outboundTime,
      departure_date: departureDate,
      departure_time: returnTime,
      service_type_code: serviceTypeCode,
      train_arrival_number: isTrainKind ? trainArrivalNumber : null,
      train_arrival_time: isTrainKind ? outboundTime : null,
      train_departure_number: isTrainKind ? trainDepartureNumber : null,
      train_departure_time: isTrainKind ? returnTime : null,
      pickup_hotel: pickupHotel,
      pickup_alert: pickupAlert,
      source_total_amount_cents: sourceTotalCents,
      source_price_per_pax_cents: sourcePricePerPaxCents,
      source_amount_currency: "EUR",
      phone: clean(form.cliente_cellulare) ?? "N/D",
      notes: notesParts,
      status: "new",
      created_by_user_id: userId,
      booking_service_kind: bookingKind
    })
    .select("id").single();

  if (serviceError || !service?.id) {
    return NextResponse.json({ ok: false, error: serviceError?.message ?? "Errore creazione servizio." }, { status: 500 });
  }

  // ── Aggiorna inbound_email con linked_service_id ──────────────────────────
  await admin
    .from("inbound_emails")
    .update({ parsed_json: { ...parsedJson, pdf_import: { ...parsedJson.pdf_import, linked_service_id: service.id } } })
    .eq("id", inboundEmail.id);

  // ── Auto-allocazione bus ──────────────────────────────────────────────────
  let autoAllocResult: { allocated: boolean; unit_label?: string; reason?: string } = { allocated: false };
  if (bookingKind === "bus_city_hotel" && busFamilyCode && canonicalBusCity) {
    autoAllocResult = await tryAutoAllocateBus(
      auth.admin,
      tenantId,
      service.id,
      busFamilyCode,
      canonicalBusCity,
      passengers,
      arrivalDate,
      departureDate,
      userId
    ).catch((err) => ({ allocated: false, reason: String(err?.message ?? err) }));
  } else {
  }

  // Traccia la decisione "Aggiungi come nuova" quando l'operatore ha creato un
  // nuovo record pur avendo visto il pannello duplicati (force / action:"create_new").
  // Stesso evento del flusso email (app/api/email/inbox-approve/route.ts), sullo
  // stesso sistema audit — nessun sistema parallelo. `channel:"pdf_upload"`
  // allinea i details agli altri rami (update_existing / update_existing_rejected).
  if (force) {
    auditLog({
      event: "inbox_duplicate_resolution",
      tenantId,
      userId,
      role: auth.membership.role,
      inboundEmailId: inboundEmail.id,
      serviceId: service.id,
      duplicate: true,
      outcome: "create_new",
      details: {
        existing_service_id: clean(body.existing_service_id) ?? null,
        channel: "pdf_upload",
      },
    });
  }

  return NextResponse.json({
    ok: true,
    inbound_email_id: inboundEmail.id,
    draft_service_id: service.id,
    auto_allocation: autoAllocResult
  });
}
