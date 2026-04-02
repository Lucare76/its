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

  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

  let body: { inbound_email_id?: string; form?: FormState };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  const { inbound_email_id, form } = body;
  if (!inbound_email_id) return NextResponse.json({ ok: false, error: "inbound_email_id mancante." }, { status: 400 });
  if (!form) return NextResponse.json({ ok: false, error: "Dati form mancanti." }, { status: 400 });

  const arrivalDate = parseDate(form.data_arrivo);
  if (!arrivalDate) return NextResponse.json({ ok: false, error: "Data arrivo non valida." }, { status: 422 });
  if (!clean(form.cliente_nome)) return NextResponse.json({ ok: false, error: "Nome cliente obbligatorio." }, { status: 422 });
  if (!clean(form.hotel)) return NextResponse.json({ ok: false, error: "Hotel obbligatorio." }, { status: 422 });

  const departureDate = parseDate(form.data_partenza);
  const outboundTime = normalizeTime(form.orario_arrivo);
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
  if (!outboundTime) {
    return NextResponse.json(
      { ok: false, error: "Orario arrivo non valido o mancante. Inserisci un orario reale nel formato HH:MM prima di confermare." },
      { status: 422 }
    );
  }

  const textHash = hashString(JSON.stringify(form)).slice(0, 24);
  const compositeKey = slug(`${customerName}|${arrivalDate}|${hotelName ?? "hotel-nd"}`);
  const dedupeKey = hashString([practiceNumber, customerName, arrivalDate, hotelName, textHash].filter(Boolean).join("|")).slice(0, 24);

  // ── Risolvi / crea hotel ──────────────────────────────────────────────────
  const hotelId = await resolveOrCreateHotel(auth.admin, tenantId, hotelName);
  if (!hotelId) return NextResponse.json({ ok: false, error: "Hotel non trovato e non creabile." }, { status: 500 });

  // ── Note servizio ─────────────────────────────────────────────────────────
  const agency = form.agenzia ?? "unknown";
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
  const { data: service, error: serviceError } = await (auth.admin as any)
    .from("services")
    .insert({
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

  // ── Marca inbound_email come confermata ───────────────────────────────────
  const { data: emailRow } = await (auth.admin as any)
    .from("inbound_emails")
    .select("parsed_json")
    .eq("id", inbound_email_id)
    .eq("tenant_id", tenantId)
    .single();

  await (auth.admin as any)
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

  return NextResponse.json({ ok: true, service_id: service.id, inbound_email_id });
}
