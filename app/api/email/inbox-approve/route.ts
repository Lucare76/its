/**
 * POST /api/email/inbox-approve
 *
 * L'operatore approva una email in inbox: prende il form editato e crea
 * un servizio confermato collegato all'inbound_email esistente.
 *
 * Body: { inbound_email_id: string, form: ClaudeFormState }
 * Protetto: admin / operator.
 */

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { canonicalizeKnownHotelName, normalizeHotelAliasValue } from "@/lib/server/hotel-aliases";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";
import { autoLinkImportedServices } from "@/lib/server/transfer-ischia-blocks";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { buildDuplicateProbe, lookupBookingDuplicates, hydrateDuplicateMatches } from "@/lib/server/agency-pdf-import";
import { resolveIncomingFerryMeta } from "@/lib/server/ferry-connection-lookup";
import { auditLog } from "@/lib/server/ops-audit";
import { logServiceChange, readServiceSnapshot } from "@/lib/server/service-audit-log";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

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
  /** Opzionale: orario pickup hotel scelto/corretto manualmente dall'operatore
   * nel pannello Inbox (vedi app/(app)/inbox/page.tsx). Se presente ha priorità
   * sul calcolo automatico sotto (applyPickupCalc) — l'operatore vede già un
   * suggerimento calcolato con la stessa regola, questo campo permette solo di
   * confermarlo o correggerlo prima di approvare. */
  pickup_hotel?: string;
};

// ─── Helpers (identici a claude-save-draft) ────────────────────────────────

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

// Deriva la compagnia diretta (SNAV/MEDMAR) dai codici mezzo estratti da Claude
// (numero_mezzo_andata/ritorno — per transfer_port_hotel contengono "SNAV" o
// "MEDMAR", non un vero numero corsa). Necessario per interrogare le tabelle
// SNAV_DIRECT/MEDMAR_DIRECT di lib/departure-pickup-rules.ts, che richiedono
// transport_type "snav"|"medmar" — diverso da calcPickupTime.ts (calc-pickup-time.ts),
// che copre solo mezzo treno/aereo e non si applica ai transfer porto-hotel puri.
function tipoToBookingKind(tipo: string): { bookingKind: string; transportMode: string } {
  if (tipo === "transfer_airport_hotel") return { bookingKind: "transfer_airport_hotel", transportMode: "unknown" };
  if (tipo === "transfer_port_hotel") return { bookingKind: "transfer_port_hotel", transportMode: "hydrofoil" };
  if (tipo === "bus_city_hotel") return { bookingKind: "bus_city_hotel", transportMode: "bus" };
  if (tipo === "excursion") return { bookingKind: "excursion", transportMode: "bus" };
  return { bookingKind: "transfer_train_hotel", transportMode: "train" };
}

// Valori ammessi dal constraint services_service_type_code_valid (vedi
// supabase/migrations/0021/0024/0030_*.sql) — identico a claude-save-draft.
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
    .insert({ tenant_id: tenantId, name, normalized_name: slug(name), address: "Ischia", city: "Ischia", zone: "Ischia Porto", lat: 40.7405, lng: 13.9438, source: "claude_email_import", is_active: true })
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
    inbound_email_id?: string;
    form?: FormState;
    /**
     * Decisione esplicita dell'operatore nel pannello "prenotazione già
     * esistente" (app/(app)/inbox/page.tsx):
     *  - "discard_duplicate" → scarta la nuova comunicazione, nessuna scrittura
     *    sui services, l'import resta tracciato come scartato;
     *  - "update_existing" → aggiorna il record esistente indicato in
     *    `existing_service_id` con i soli campi realmente cambiati (mai
     *    distruttivo: stesso ID, stesse relazioni, stato/assegnazioni intatti);
     *  - "create_new" → crea comunque una nuova prenotazione.
     * La scelta NON è mai automatica: il server la esegue solo se ricevuta.
     */
    action?: "discard_duplicate" | "update_existing" | "create_new";
    /** Service esistente scelto per "update_existing" (ri-validato server-side). */
    existing_service_id?: string;
    /** Alias retro-compatibile di action:"create_new". */
    confirm_duplicate?: boolean;
    /** Alias legacy: collega la email al service senza INSERT (nessun update campi). */
    link_to_service_id?: string;
  };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  const { inbound_email_id, form } = body;
  const action = body.action ?? null;
  const confirmDuplicate = body.confirm_duplicate === true || action === "create_new";
  const linkToServiceId = clean(body.link_to_service_id);
  const updateExistingId = action === "update_existing" ? clean(body.existing_service_id) : null;
  if (!inbound_email_id) return NextResponse.json({ ok: false, error: "inbound_email_id mancante." }, { status: 400 });

  // ── SCARTA DUPLICATO ─────────────────────────────────────────────────────
  // Nessuna scrittura sui services (né INSERT né UPDATE): l'operatore ha
  // deciso che la nuova comunicazione è un doppione. Si marca solo l'inbound
  // email come gestita e si lascia traccia nell'audit esistente.
  if (action === "discard_duplicate") {
    const { data: emailRow } = await admin
      .from("inbound_emails")
      .select("parsed_json")
      .eq("tenant_id", tenantId)
      .eq("id", inbound_email_id)
      .maybeSingle();
    const parsedJson = (emailRow?.parsed_json ?? {}) as Record<string, unknown>;
    await admin
      .from("inbound_emails")
      .update({
        parsed_json: {
          ...parsedJson,
          review_status: "confirmed",
          duplicate_resolution: "discarded",
          duplicate_resolved_by: userId,
          duplicate_resolved_at: new Date().toISOString(),
        },
      })
      .eq("tenant_id", tenantId)
      .eq("id", inbound_email_id);
    auditLog({
      event: "inbox_duplicate_resolution",
      tenantId,
      userId,
      role: auth.membership.role,
      inboundEmailId: inbound_email_id,
      serviceId: clean(body.existing_service_id) ?? null,
      duplicate: true,
      outcome: "discard_duplicate",
      details: { existing_service_id: clean(body.existing_service_id) ?? null },
    });
    return NextResponse.json({ ok: true, discarded: true, inbound_email_id });
  }

  // ── MODIFICA PRENOTAZIONE ESISTENTE ──────────────────────────────────────
  // L'aggiornamento dei campi del service esistente è già stato fatto dalla UI
  // via PATCH /api/ops/services/[id] (endpoint esistente, con audit
  // logServiceChange). Qui chiudiamo il flusso Inbox: nessun INSERT, la email
  // risulta gestita e collegata al service scelto.
  if (linkToServiceId) {
    const { data: target } = await admin
      .from("services")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", linkToServiceId)
      .maybeSingle();
    if (!target?.id) {
      return NextResponse.json({ ok: false, error: "Servizio esistente non trovato." }, { status: 404 });
    }
    const { data: emailRow } = await admin
      .from("inbound_emails")
      .select("parsed_json")
      .eq("tenant_id", tenantId)
      .eq("id", inbound_email_id)
      .maybeSingle();
    const parsedJson = (emailRow?.parsed_json ?? {}) as Record<string, unknown>;
    await admin
      .from("inbound_emails")
      .update({
        parsed_json: {
          ...parsedJson,
          review_status: "confirmed",
          linked_service_id: linkToServiceId,
          linked_via: "duplicate_modify",
        },
      })
      .eq("tenant_id", tenantId)
      .eq("id", inbound_email_id);
    auditLog({
      event: "inbox_email_linked_existing_service",
      tenantId,
      userId,
      role: auth.membership.role,
      serviceId: linkToServiceId,
      inboundEmailId: inbound_email_id,
      outcome: "linked",
    });
    return NextResponse.json({ ok: true, linked: true, service_id: linkToServiceId, inbound_email_id });
  }

  if (!form) return NextResponse.json({ ok: false, error: "Dati form mancanti." }, { status: 400 });

  const { data: existingService } = await admin
    .from("services")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("inbound_email_id", inbound_email_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const arrivalDate = parseDate(form.data_arrivo);
  if (!arrivalDate) return NextResponse.json({ ok: false, error: "Data arrivo non valida." }, { status: 422 });
  if (!clean(form.cliente_nome)) return NextResponse.json({ ok: false, error: "Nome cliente obbligatorio." }, { status: 422 });
  if (!clean(form.hotel)) return NextResponse.json({ ok: false, error: "Hotel obbligatorio." }, { status: 422 });

  const departureDate = parseDate(form.data_partenza);
  const returnTime = normalizeTime(form.orario_partenza);
  const customerName = clean(form.cliente_nome) ?? "Cliente da verificare";
  const hotelName = clean(form.hotel);
  const practiceNumber = clean(form.numero_pratica);
  const trainArrivalNumber = clean(form.treno_andata);
  const trainDepartureNumber = clean(form.treno_ritorno);
  const transportCode = trainArrivalNumber && trainDepartureNumber
    ? `${trainArrivalNumber} / ${trainDepartureNumber}`
    : trainArrivalNumber ?? trainDepartureNumber ?? null;
  const arrivalPlace = clean(form.citta_partenza);
  const passengers = Math.max(1, Math.min(99, Number(form.n_pax) || 1));
  const totalAmount = form.totale_pratica ? parseFloat(form.totale_pratica.replace(",", ".")) : null;
  const sourceTotalCents = totalAmount && isFinite(totalAmount) ? Math.round(totalAmount * 100) : null;
  const sourcePricePerPaxCents = sourceTotalCents && passengers > 0 ? Math.round(sourceTotalCents / passengers) : null;

  const { bookingKind, transportMode } = tipoToBookingKind(form.tipo_servizio ?? "transfer_station_hotel");
  const isTrainKind = bookingKind === "transfer_train_hotel";
  const serviceTypeCode = toServiceTypeCode(form.tipo_servizio);

  // Orario andata: dal form; se assente nei bus, prende l'orario dal catalogo fermate
  const resolvedBusStop = bookingKind === "bus_city_hotel" ? resolveBusStop(arrivalPlace) : null;
  const outboundTime = normalizeTime(form.orario_arrivo) ?? (bookingKind === "bus_city_hotel" ? (resolvedBusStop?.time ?? null) : null);

  // Per i servizi bus l'orario è opzionale (spesso non presente nel PDF)
  if (!outboundTime && bookingKind !== "bus_city_hotel") {
    return NextResponse.json(
      { ok: false, error: "Orario arrivo non valido o mancante. Inserisci un orario reale nel formato HH:MM prima di confermare." },
      { status: 422 }
    );
  }

  const textHash = hashString(JSON.stringify(form)).slice(0, 24);
  const compositeKey = slug(`${customerName}|${arrivalDate}|${hotelName ?? "hotel-nd"}`);
  const dedupeKey = hashString([practiceNumber, customerName, arrivalDate, hotelName, textHash].filter(Boolean).join("|")).slice(0, 24);

  // ── AGGIORNA PRENOTAZIONE ESISTENTE ─────────────────────────────────────
  // Decisione esplicita "update_existing". Il server NON si fida dell'ID
  // arrivato dal client: ricostruisce il probe dai campi del form, riesegue
  // il deduplicatore condiviso e accetta l'update SOLO se `existing_service_id`
  // è davvero fra i match proposti per questo import (match certo o possibile).
  // Poi aggiorna il record IN-PLACE — stesso ID, stesse relazioni, stesso
  // audit/storico — con i soli campi realmente presenti nella nuova
  // comunicazione E diversi da quelli a sistema. Mai toccati: status,
  // is_draft, assegnazioni, pickup manuale, created_by_user_id, linked_service_id.
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
        inboundEmailId: inbound_email_id,
        serviceId: updateExistingId,
        duplicate: true,
        outcome: "update_existing_rejected",
        details: { reason: "service_not_in_matches", allowed: [...allowed] },
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

    // Solo campi con un valore reale nella nuova comunicazione. Il confronto
    // con il valore a sistema evita sia righe fantasma nell'audit sia — punto
    // chiave del requisito — la sovrascrittura di una correzione manuale
    // dell'operatore quando il nuovo import NON porta quel campo.
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

    // Hotel: la nuova comunicazione può correggere la struttura (es.
    // "PARCO HOTEL TERME VILLA TERESA" → "VILLA TERESA"). Stesso helper del
    // flusso di creazione; si aggiorna solo hotel_id, mai altro.
    if (hotelName) {
      const newHotelId = await resolveOrCreateHotel(auth.admin, tenantId, hotelName);
      if (newHotelId && newHotelId !== before.hotel_id) patch.hotel_id = newHotelId;
    }

    // Numero pratica: vive nel marker [practice:...] dentro notes → swap mirato,
    // il resto delle note operative resta intatto.
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
      if (updErr) {
        return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
      }
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

    const { data: emailRow } = await admin
      .from("inbound_emails")
      .select("parsed_json")
      .eq("tenant_id", tenantId)
      .eq("id", inbound_email_id)
      .maybeSingle();
    const parsedJson = (emailRow?.parsed_json ?? {}) as Record<string, unknown>;
    await admin
      .from("inbound_emails")
      .update({
        parsed_json: {
          ...parsedJson,
          review_status: "confirmed",
          linked_service_id: updateExistingId,
          linked_via: "duplicate_update",
          duplicate_resolution: "updated_existing",
          duplicate_resolved_by: userId,
          duplicate_resolved_at: new Date().toISOString(),
        },
      })
      .eq("tenant_id", tenantId)
      .eq("id", inbound_email_id);

    auditLog({
      event: "inbox_duplicate_resolution",
      tenantId,
      userId,
      role: auth.membership.role,
      inboundEmailId: inbound_email_id,
      serviceId: updateExistingId,
      duplicate: true,
      outcome: "update_existing",
      details: { existing_service_id: updateExistingId, changed_fields: Object.keys(patch) },
    });

    return NextResponse.json({
      ok: true,
      updated: true,
      service_id: updateExistingId,
      changed_fields: Object.keys(patch),
      inbound_email_id,
    });
  }

  // ── Controllo duplicati LIVE sul DB (fonte di verità) ────────────────────
  // `existingService` sopra copre solo l'idempotenza della STESSA email (bozza
  // già collegata a questo inbound_email_id). Qui invece cerchiamo la STESSA
  // prenotazione entrata da un altro canale/altra email, riusando il
  // deduplicatore condiviso di lib/server/agency-pdf-import.ts. Il flag
  // `duplicate_alert` del poller IMAP resta solo un'indicazione preliminare.
  if (!existingService?.id && !confirmDuplicate) {
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
      // GET /api/ops/services/[id], mai un resolver ferry nel client.
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
      auditLog({
        event: "inbox_approve_duplicate_detected",
        level: "warn",
        tenantId,
        userId,
        role: auth.membership.role,
        inboundEmailId: inbound_email_id,
        duplicate: true,
        outcome: "duplicate_prompt",
        details: { match_count: matches.length, certain_service_id },
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

  // ── Risolvi / crea hotel ──────────────────────────────────────────────────
  const hotelId = await resolveOrCreateHotel(auth.admin, tenantId, hotelName);
  if (!hotelId) return NextResponse.json({ ok: false, error: "Hotel non trovato e non creabile." }, { status: 500 });

  // ── Note servizio ─────────────────────────────────────────────────────────
  const agency = form.agenzia ?? "unknown";

  // ── Pickup hotel per transfer_port_hotel puri (SNAV/MEDMAR diretti) ──────
  // Canonico via apply-pickup-calc.ts (stesso calcolatore usato da
  // new-booking/agency-bookings/Excel per lo stesso scenario operativo — vedi
  // audit centralizzazione write-path pickup) invece di una logica locale
  // duplicata. Il testo compagnia per transfer_port_hotel non e' nel campo
  // vessel qui ma in treno_andata/treno_ritorno (per questo tipo contengono
  // "SNAV"/"MEDMAR", non un vero numero corsa) — passato come `vessel` alla
  // funzione condivisa, che usa lo stesso derivePortCarrier() su quel testo.
  let pickupHotel: string | null = null;
  let pickupAlert: string | null = null;
  const operatorPickupHotel = clean(form.pickup_hotel);
  if (operatorPickupHotel) {
    // L'operatore ha visto il suggerimento calcolato in Inbox (stessa regola
    // sotto, eseguita client-side in app/(app)/inbox/page.tsx) e lo ha
    // confermato o corretto: la sua scelta ha sempre priorità sul calcolo
    // automatico, nessun pickupAlert in questo caso.
    pickupHotel = operatorPickupHotel;
  } else if (bookingKind === "transfer_port_hotel" && returnTime) {
    const { data: hotelZoneRow } = await auth.admin.from("hotels").select("zone").eq("id", hotelId).maybeSingle();
    const zoneRaw = (hotelZoneRow as { zone?: string | null } | null)?.zone ?? null;
    const pickupFields = applyPickupCalc({
      direction: "departure",
      booking_service_kind: bookingKind,
      time: returnTime,
      billing_party_name: agency,
      vessel: trainDepartureNumber ?? trainArrivalNumber ?? null,
      hotel_zone: zoneRaw,
      hotel_name: hotelName ?? null,
    });
    pickupHotel = pickupFields.pickup_hotel ?? null;
    pickupAlert = pickupFields.pickup_alert ?? null;
  }
  const notesParts = [
    "[email_import] Booking approvato da email",
    `[source:claude_email]`,
    `[inbound_email:${inbound_email_id}]`,
    `[manual_review:true]`,
    `[billing_party_name:${agency}]`,
    practiceNumber ? `[practice:${practiceNumber}]` : null,
    `[pdf_text_hash:${textHash}]`,
    `[pdf_dedupe:${dedupeKey}]`,
    `[pdf_composite:${compositeKey}]`,
    trainArrivalNumber ? `[train_arrival_number:${trainArrivalNumber}]` : null,
    trainDepartureNumber ? `[train_departure_number:${trainDepartureNumber}]` : null,
    arrivalPlace ? `pickup/porto: ${arrivalPlace}` : null,
    hotelName ? `hotel/destinazione: ${hotelName}` : null,
    clean(form.note)
  ].filter(Boolean).join(" | ");

  // ── Crea servizio confermato ──────────────────────────────────────────────
  const servicePayload = {
      tenant_id: tenantId,
      inbound_email_id,
      is_draft: false,
      date: arrivalDate,
      time: outboundTime,
      service_type: "transfer",
      direction: "arrival",
      vessel: arrivalPlace ?? "Transfer da email",
      pax: passengers,
      hotel_id: hotelId,
      customer_name: customerName,
      billing_party_name: agency,
      outbound_time: outboundTime,
      return_time: returnTime,
      // Campi operativi letti dalla card/edit prenotazione (bookingListTransportTimes,
      // app/(app)/services/[id]/edit) senza fallback su date/time/outbound_time/return_time:
      // vanno valorizzati qui allo stesso modo del flusso di creazione manuale
      // (app/api/ops/new-booking), altrimenti la card mostra "—" anche quando il
      // parser ha estratto correttamente arrivo/partenza dal PDF.
      arrival_date: arrivalDate,
      arrival_time: outboundTime,
      departure_date: departureDate,
      departure_time: returnTime,
      meeting_point: arrivalPlace,
      transport_code: transportCode,
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
  };

  // L'ingest email crea gia una bozza: l'approvazione deve confermare quel
  // record, non inserirne uno identico. Se non esiste una bozza, crea il servizio.
  const serviceResult = existingService?.id
    ? await admin
        .from("services")
        .update(servicePayload)
        .eq("tenant_id", tenantId)
        .eq("id", existingService.id)
        .select("id")
        .single()
    : await admin
        .from("services")
        .insert(servicePayload)
        .select("id")
        .single();
  const { data: service, error: serviceError } = serviceResult;

  if (serviceError || !service?.id) {
    if (serviceError?.code === "23505") {
      const { data: concurrentService } = await admin
        .from("services")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("inbound_email_id", inbound_email_id)
        .limit(1)
        .maybeSingle();
      if (concurrentService?.id) {
        return NextResponse.json({ ok: true, service_id: concurrentService.id, inbound_email_id, already_existed: true });
      }
    }
    return NextResponse.json({ ok: false, error: serviceError?.message ?? "Errore creazione servizio." }, { status: 500 });
  }

  // ── Collega automaticamente al blocco traghetto se Medmar/SNAV ───────────
  await autoLinkImportedServices(admin, tenantId, [service.id]);

  // ── Marca inbound_email come confermata ───────────────────────────────────
  const { data: emailRow } = await admin
    .from("inbound_emails")
    .select("parsed_json")
    .eq("id", inbound_email_id)
    .eq("tenant_id", tenantId)
    .single();

  await admin
    .from("inbound_emails")
    .update({
      parsed_json: {
        ...(emailRow?.parsed_json ?? {}),
        review_status: "confirmed",
        confirmed_at: new Date().toISOString(),
        linked_service_id: service.id,
        confirmed_by: userId
      }
    })
    .eq("id", inbound_email_id)
    .eq("tenant_id", tenantId);

  // Traccia la decisione "aggiungi comunque" quando l'operatore ha creato un
  // nuovo record pur avendo visto il pannello duplicati.
  if (confirmDuplicate && !existingService?.id) {
    auditLog({
      event: "inbox_duplicate_resolution",
      tenantId,
      userId,
      role: auth.membership.role,
      inboundEmailId: inbound_email_id,
      serviceId: service.id,
      duplicate: true,
      outcome: "create_new",
      details: { existing_service_id: clean(body.existing_service_id) ?? null },
    });
  }

  return NextResponse.json({ ok: true, service_id: service.id, inbound_email_id });
}
