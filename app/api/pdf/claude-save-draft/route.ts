/**
 * POST /api/pdf/claude-save-draft
 *
 * Riceve il JSON estratto da Claude + il PDF base64 e crea:
 *   1. Un record in inbound_emails (con parsed_json.pdf_import)
 *   2. Un draft service collegato
 *
 * Il record appare subito in /pdf-imports per revisione finale.
 * Protetto: admin / operator.
 */

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

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

  // ISO: 2026-04-19
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // dd/mm/yyyy or dd-mm-yyyy
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;

  // dd-mmm-yy or dd-mmm-yyyy (es. "19-apr-26" o "19-apr-2026")
  const dmyAbbr = s.match(/^(\d{1,2})[-\s]([a-zA-Zàèéùì]+)[-\s](\d{2,4})$/i);
  if (dmyAbbr) {
    const month = IT_MONTHS[dmyAbbr[2].toLowerCase()];
    if (month) {
      const yearRaw = dmyAbbr[3];
      const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
      return `${year}-${month}-${dmyAbbr[1].padStart(2, "0")}`;
    }
  }

  // dd mmmm yyyy (es. "19 aprile 2026")
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

type ClaudeService = {
  data?: string | null;
  tipo?: string | null;
  mezzo?: string | null;
  compagnia?: string | null;
  numero_mezzo?: string | null;
  orario?: string | null;
  partenza?: string | null;
  destinazione?: string | null;
  importo?: number | null;
  totale?: number | null;
};

type ClaudeJson = {
  agenzia?: string | null;
  numero_conferma?: string | null;
  numero_pratica?: string | null;
  data_conferma?: string | null;
  cliente_nome?: string | null;
  cliente_cellulare?: string | null;
  n_pax?: number | null;
  hotel?: string | null;
  data_arrivo?: string | null;
  data_partenza?: string | null;
  servizi?: ClaudeService[];
  totale_pratica?: number | null;
  note_operative?: string | null;
};

function deduceServiceType(servizi: ClaudeService[] = [], agency: string) {
  const allTipi = servizi.map((s) => (s.tipo ?? "").toUpperCase()).join(" ");
  const allMezzi = servizi.map((s) => (s.mezzo ?? "").toUpperCase()).join(" ");
  const allComp = servizi.map((s) => (s.compagnia ?? "").toUpperCase()).join(" ");
  const combined = `${allTipi} ${allMezzi} ${allComp}`;

  if (/AEROPORTO|AIRPORT/.test(combined))
    return { serviceType: "transfer_airport_hotel", bookingKind: "transfer_airport_hotel", transportMode: "unknown" } as const;
  if (/STAZIONE|TRENO|ITALO|TRENITALIA|FLIXBUS/.test(combined))
    return { serviceType: "transfer_station_hotel", bookingKind: "transfer_train_hotel", transportMode: "train" } as const;
  if (/PORTO|TRAGHETTO|ALISCAFO|FERRY|HYDROFOIL/.test(combined))
    return { serviceType: "transfer_port_hotel", bookingKind: "transfer_port_hotel", transportMode: "hydrofoil" } as const;

  // Default per agenzia
  if (agency === "aleste" || agency === "zigolo") {
    return { serviceType: "transfer_station_hotel", bookingKind: "transfer_train_hotel", transportMode: "train" } as const;
  }
  return { serviceType: "transfer_port_hotel", bookingKind: "transfer_port_hotel", transportMode: "hydrofoil" } as const;
}

async function resolveOrCreateHotel(admin: ReturnType<typeof import("@supabase/supabase-js").createClient>, tenantId: string, hotelName: string | null) {
  const name = clean(hotelName) ?? "Hotel da verificare";
  const normalizedName = name.toLowerCase();

  const { data: hotels } = await (admin as any).from("hotels").select("id, name").eq("tenant_id", tenantId).limit(500);
  const list = (hotels ?? []) as Array<{ id: string; name: string }>;

  const matched =
    list.find((h) => h.name.toLowerCase() === normalizedName) ??
    list.find((h) => h.name.toLowerCase().includes(normalizedName)) ??
    list.find((h) => normalizedName.includes(h.name.toLowerCase()));
  if (matched?.id) return matched.id;

  const { data: created } = await (admin as any)
    .from("hotels")
    .insert({ tenant_id: tenantId, name, normalized_name: slug(name), address: "Ischia", city: "Ischia", zone: "Ischia Porto", lat: 40.7405, lng: 13.9438, source: "claude_pdf_import", is_active: true })
    .select("id")
    .single();
  return (created as { id: string } | null)?.id ?? null;
}

// ─── Route ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

  let body: { extracted?: ClaudeJson; pdf_base64?: string; filename?: string; agency?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 });
  }

  const { extracted, pdf_base64, filename = "upload.pdf", agency = "unknown" } = body;
  if (!extracted) return NextResponse.json({ ok: false, error: "Dati estratti mancanti." }, { status: 400 });

  // ── Date ─────────────────────────────────────────────────────────────────
  const arrivalDate = parseDate(extracted.data_arrivo);
  if (!arrivalDate) {
    return NextResponse.json({ ok: false, error: "Data arrivo non valida o mancante. Compila il campo manualmente." }, { status: 422 });
  }
  const departureDate = parseDate(extracted.data_partenza);

  // ── Servizi ───────────────────────────────────────────────────────────────
  const servizi = extracted.servizi ?? [];
  const andataService = servizi[0] ?? null;
  const ritornoService = servizi.find((s, i) => i > 0 && /ritorno|hotel.stazione|hotel.aeroporto|hotel.porto/i.test(s.tipo ?? "")) ?? servizi[1] ?? null;

  const { serviceType, bookingKind, transportMode } = deduceServiceType(servizi, agency);

  const outboundTime = normalizeTime(andataService?.orario) ?? "00:00";
  const returnTime = normalizeTime(ritornoService?.orario);
  const trainArrivalNumber = clean(andataService?.numero_mezzo);
  const trainDepartureNumber = clean(ritornoService?.numero_mezzo);
  const arrivalPlace = clean(andataService?.partenza);
  const carrierCompany = clean(andataService?.compagnia);

  // ── Hash / dedupe ─────────────────────────────────────────────────────────
  const pdfHash = pdf_base64 ? createHash("sha256").update(Buffer.from(pdf_base64, "base64")).digest("hex").slice(0, 24) : hashString(JSON.stringify(extracted)).slice(0, 24);
  const textHash = hashString(JSON.stringify(extracted)).slice(0, 24);
  const customerName = clean(extracted.cliente_nome) ?? "Cliente da verificare";
  const practiceNumber = clean(extracted.numero_pratica);
  const nsReference = clean(extracted.numero_conferma);
  const hotelName = clean(extracted.hotel);
  const compositeKey = slug(`${customerName}|${arrivalDate}|${hotelName ?? "hotel-nd"}`);
  const dedupeKey = hashString([practiceNumber, nsReference, customerName, arrivalDate, hotelName, textHash].filter(Boolean).join("|")).slice(0, 24);

  const agencyLabels: Record<string, string> = {
    aleste: "Aleste Viaggi", angelino: "Angelino Tour & Events", holidayweb: "Holiday Web",
    sosandra: "Sosandra / Rossella Viaggi", zigolo: "Zigolo Viaggi", unknown: "Agenzia non identificata"
  };
  const agencyLabel = agencyLabels[agency] ?? extracted.agenzia ?? agency;

  const passengers = Math.max(1, Math.min(16, Number(extracted.n_pax ?? 1)));
  const sourceTotalCents = extracted.totale_pratica ? Math.round(extracted.totale_pratica * 100) : null;
  const sourcePricePerPaxCents = sourceTotalCents && passengers > 0 ? Math.round(sourceTotalCents / passengers) : null;

  const fieldsFound: string[] = [];
  const missingFields: string[] = [];
  for (const [key, value] of [
    ["customer_full_name", customerName !== "Cliente da verificare" ? customerName : null],
    ["customer_phone", clean(extracted.cliente_cellulare)],
    ["arrival_date", arrivalDate],
    ["departure_date", departureDate],
    ["hotel_or_destination", hotelName],
    ["passengers", passengers > 1 ? passengers : null],
    ["source_total_amount_cents", sourceTotalCents],
    ["outbound_time", outboundTime !== "00:00" ? outboundTime : null],
    ["train_arrival_number", trainArrivalNumber],
    ["train_departure_number", trainDepartureNumber]
  ] as Array<[string, unknown]>) {
    if (value !== null && value !== undefined && value !== "") {
      fieldsFound.push(key);
    } else {
      missingFields.push(key);
    }
  }

  const normalized = {
    parser_key: `claude_${agency}`,
    parser_score: 0.92,
    parsing_quality: "high" as const,
    agency_name: agencyLabel,
    billing_party_name: agencyLabel,
    external_reference: practiceNumber ?? nsReference ?? compositeKey,
    service_type: serviceType,
    service_variant: serviceType === "transfer_station_hotel" ? "train_station_hotel" as const : null,
    transport_mode: transportMode,
    transport_code: [trainArrivalNumber, trainDepartureNumber].filter(Boolean).join("/") || null,
    transport_reference_outward: trainArrivalNumber,
    transport_reference_return: trainDepartureNumber,
    arrival_transport_code: trainArrivalNumber,
    departure_transport_code: trainDepartureNumber,
    train_arrival_number: trainArrivalNumber,
    train_arrival_time: outboundTime !== "00:00" ? outboundTime : null,
    train_departure_number: trainDepartureNumber,
    train_departure_time: returnTime,
    bus_city_origin: arrivalPlace,
    booking_kind: bookingKind,
    service_type_deduced: "transfer" as const,
    customer_first_name: null,
    customer_last_name: null,
    customer_full_name: customerName,
    customer_email: null,
    customer_phone: clean(extracted.cliente_cellulare) ?? "N/D",
    arrival_date: arrivalDate,
    outbound_time: outboundTime,
    departure_date: departureDate,
    return_time: returnTime,
    arrival_place: arrivalPlace,
    hotel_or_destination: hotelName,
    passengers,
    source_total_amount_cents: sourceTotalCents,
    source_price_per_pax_cents: sourcePricePerPaxCents,
    source_amount_currency: "EUR",
    notes: clean(extracted.note_operative) ?? "",
    fields_found: fieldsFound,
    missing_fields: missingFields,
    include_ferry_tickets: transportMode === "ferry" || transportMode === "hydrofoil",
    carrier_company: carrierCompany,
    pdf_hash: pdfHash,
    text_hash: textHash,
    dedupe_key: dedupeKey,
    dedupe_components: { practice_number: practiceNumber, ns_reference: nsReference, customer_name: customerName, arrival_date: arrivalDate, hotel: hotelName, pdf_hash: pdfHash, text_hash: textHash, composite_key: compositeKey },
    parser_logs: [`Estratto con Claude AI (claude-sonnet-4-6)`, `Agenzia rilevata: ${agency}`, `Campi trovati: ${fieldsFound.length}`, `Campi mancanti: ${missingFields.join(", ") || "nessuno"}`]
  };

  const parsedJson = {
    source: "claude-ai-extraction",
    from_email: "operator@manual-upload.local",
    subject: `Import Claude AI: ${filename}`,
    received_at: new Date().toISOString(),
    review_status: "needs_review",
    attachments: [{ filename, mime_type: "application/pdf", has_content: false }],
    pdf_parser: { key: `claude_${agency}`, mode: "dedicated", score: 0.92, selection_confidence: "high", selection_reason: `Claude AI vision — agenzia ${agency}`, fallback_reason: null, candidates: [] },
    parser_suggestions: null,
    pdf_import: {
      import_mode: "draft",
      import_state: "draft",
      parser_key: `claude_${agency}`,
      parsing_quality: "high",
      fields_found: fieldsFound,
      missing_fields: missingFields,
      parser_logs: normalized.parser_logs,
      raw_transfer_parser: { parsed_services: [], practice_number: practiceNumber, ns_reference: nsReference },
      dedupe: { key: dedupeKey, external_reference: normalized.external_reference, ...normalized.dedupe_components },
      original_normalized: normalized,
      normalized,
      effective_normalized: normalized,
      reviewed_values: null,
      has_manual_review: false,
      reviewed_by: null,
      reviewed_at: null,
      linked_service_id: null,
      possible_existing_matches: [],
      claude_raw: extracted
    }
  };

  // ── Inserisci inbound_email ───────────────────────────────────────────────
  const bodyText = `Import manuale PDF con Claude AI. Agenzia: ${agencyLabel}. Pratica: ${practiceNumber ?? "N/D"}.`;

  const { data: inboundEmail, error: inboundError } = await (auth.admin as any)
    .from("inbound_emails")
    .insert({
      tenant_id: tenantId,
      from_email: "operator@manual-upload.local",
      subject: `Import Claude AI: ${filename}`,
      raw_text: bodyText,
      body_text: bodyText,
      extracted_text: JSON.stringify(extracted, null, 2),
      parsed_json: parsedJson,
      created_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (inboundError || !inboundEmail?.id) {
    return NextResponse.json({ ok: false, error: inboundError?.message ?? "Errore inserimento inbound_email." }, { status: 500 });
  }

  // ── Risolvi / crea hotel ──────────────────────────────────────────────────
  const hotelId = await resolveOrCreateHotel(auth.admin as any, tenantId, hotelName);
  if (!hotelId) {
    return NextResponse.json({ ok: false, error: "Impossibile trovare o creare l'hotel." }, { status: 500 });
  }

  // ── Crea draft service ────────────────────────────────────────────────────
  const notesParts = [
    "[needs_review] Draft creato da PDF Claude AI",
    `[source:claude_${agency}]`,
    `[import_state:draft]`,
    practiceNumber ? `[practice:${practiceNumber}]` : null,
    nsReference ? `[ns_ref:${nsReference}]` : null,
    `[pdf_hash:${pdfHash}]`,
    `[pdf_text_hash:${textHash}]`,
    `[pdf_dedupe:${dedupeKey}]`,
    `[pdf_composite:${compositeKey}]`,
    `[billing_party_name:${agencyLabel}]`,
    trainArrivalNumber ? `[train_arrival_number:${trainArrivalNumber}]` : null,
    trainDepartureNumber ? `[train_departure_number:${trainDepartureNumber}]` : null,
    arrivalPlace ? `pickup/porto: ${arrivalPlace}` : null,
    hotelName ? `hotel/destinazione: ${hotelName}` : null,
    clean(extracted.note_operative)
  ].filter(Boolean).join(" | ");

  const { data: service, error: serviceError } = await (auth.admin as any)
    .from("services")
    .insert({
      tenant_id: tenantId,
      inbound_email_id: inboundEmail.id,
      is_draft: true,
      date: arrivalDate,
      time: outboundTime,
      service_type: "transfer",
      direction: "arrival",
      vessel: carrierCompany ?? arrivalPlace ?? "Transfer da PDF",
      pax: passengers,
      hotel_id: hotelId,
      customer_name: customerName,
      billing_party_name: agencyLabel,
      outbound_time: outboundTime,
      return_time: returnTime,
      source_total_amount_cents: sourceTotalCents,
      source_price_per_pax_cents: sourcePricePerPaxCents,
      source_amount_currency: "EUR",
      phone: clean(extracted.cliente_cellulare) ?? "N/D",
      notes: notesParts,
      status: "needs_review",
      created_by_user_id: userId,
      booking_service_kind: bookingKind
    })
    .select("id")
    .single();

  if (serviceError || !service?.id) {
    return NextResponse.json({ ok: false, error: serviceError?.message ?? "Errore creazione servizio." }, { status: 500 });
  }

  // ── Aggiorna inbound_email con linked_service_id ───────────────────────
  await (auth.admin as any)
    .from("inbound_emails")
    .update({
      parsed_json: { ...parsedJson, pdf_import: { ...parsedJson.pdf_import, linked_service_id: service.id } }
    })
    .eq("id", inboundEmail.id);

  return NextResponse.json({ ok: true, inbound_email_id: inboundEmail.id, draft_service_id: service.id });
}
