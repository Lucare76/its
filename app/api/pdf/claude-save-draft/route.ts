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

function tipoToBookingKind(tipo: string): { bookingKind: string; transportMode: string } {
  if (tipo === "transfer_airport_hotel") return { bookingKind: "transfer_airport_hotel", transportMode: "unknown" };
  if (tipo === "transfer_port_hotel") return { bookingKind: "transfer_port_hotel", transportMode: "hydrofoil" };
  if (tipo === "excursion") return { bookingKind: "excursion", transportMode: "bus" };
  return { bookingKind: "transfer_train_hotel", transportMode: "train" };
}

async function resolveOrCreateHotel(admin: any, tenantId: string, hotelName: string | null) {
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

  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

  let body: { form?: FormState; pdf_base64?: string; filename?: string; agency?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  const { form, pdf_base64, filename = "upload.pdf", agency = "unknown", force = false } = body as typeof body & { force?: boolean };
  if (!form) return NextResponse.json({ ok: false, error: "Dati form mancanti." }, { status: 400 });

  // ── Validazione campi obbligatori ─────────────────────────────────────────
  const arrivalDate = parseDate(form.data_arrivo);
  if (!arrivalDate) return NextResponse.json({ ok: false, error: "Data arrivo non valida. Usa formato 2026-04-19 oppure 19-apr-26." }, { status: 422 });
  if (!clean(form.cliente_nome)) return NextResponse.json({ ok: false, error: "Nome cliente obbligatorio." }, { status: 422 });
  if (!clean(form.hotel)) return NextResponse.json({ ok: false, error: "Hotel obbligatorio." }, { status: 422 });

  const departureDate = parseDate(form.data_partenza);
  const outboundTime = normalizeTime(form.orario_arrivo) ?? "00:00";
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

  // ── Hash / dedupe ─────────────────────────────────────────────────────────
  const pdfHash = pdf_base64
    ? createHash("sha256").update(Buffer.from(pdf_base64, "base64")).digest("hex").slice(0, 24)
    : hashString(JSON.stringify(form)).slice(0, 24);
  const textHash = hashString(JSON.stringify(form)).slice(0, 24);
  const compositeKey = slug(`${customerName}|${arrivalDate}|${hotelName ?? "hotel-nd"}`);
  const dedupeKey = hashString([practiceNumber, customerName, arrivalDate, hotelName, textHash].filter(Boolean).join("|")).slice(0, 24);
  const externalReference = practiceNumber ?? compositeKey;

  // ── Controllo duplicato PDF ───────────────────────────────────────────────
  if (!force) {
    const { data: dupService } = await (auth.admin as any)
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
  const { data: inboundEmail, error: inboundError } = await (auth.admin as any)
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
    arrivalPlace ? `pickup/porto: ${arrivalPlace}` : null,
    hotelName ? `hotel/destinazione: ${hotelName}` : null,
    clean(form.note)
  ].filter(Boolean).join(" | ");

  // ── Crea servizio confermato ──────────────────────────────────────────────
  const { data: service, error: serviceError } = await (auth.admin as any)
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
        : (arrivalPlace ?? "Transfer da PDF"),
      pax: passengers,
      hotel_id: hotelId,
      customer_name: customerName,
      billing_party_name: form.agenzia,
      outbound_time: outboundTime,
      return_time: returnTime,
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
  await (auth.admin as any)
    .from("inbound_emails")
    .update({ parsed_json: { ...parsedJson, pdf_import: { ...parsedJson.pdf_import, linked_service_id: service.id } } })
    .eq("id", inboundEmail.id);

  return NextResponse.json({ ok: true, inbound_email_id: inboundEmail.id, draft_service_id: service.id });
}
