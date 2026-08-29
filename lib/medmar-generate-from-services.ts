// Pilot: "Genera dal gestionale" for MEDMAR convocations.
//
// Pure mapping/validation: turns MEDMAR departure services (already read from
// the DB and pre-resolved by the route) into rows that are byte-compatible
// with what the MEDMAR Excel upload produces, so the SAME preview table
// renders them unchanged. No DB access, no WhatsApp, no side effects.
//
// The validation ladder is copied verbatim from
// app/api/ops/medmar-convocations/upload/route.ts (minus the Excel-only
// `INVIARE = NO` -> "escluso" branch, which has no meaning when the source
// is the management system) so a generated row is graded exactly like an
// imported one.

import {
  buildMedmarConvocationTemplateParams,
  buildMedmarConvocationPreviewText,
} from "@/lib/medmar-convocation-template";
import { formatMedmarDepartureDate } from "@/lib/medmar-convocation-format";

export const MEDMAR_DEPARTURE_KINDS = [
  "formula_medmar_napoli",
  "formula_medmar_pozzuoli",
] as const;

export type MedmarDepartureKind = (typeof MEDMAR_DEPARTURE_KINDS)[number];

export function isMedmarDepartureKind(kind: string | null | undefined): boolean {
  return kind != null && (MEDMAR_DEPARTURE_KINDS as readonly string[]).includes(kind);
}

// A service already flattened + timing-resolved by the route.
export type ServiceForConvocation = {
  service_id: string;
  customer_name: string | null;
  phone: string | null;
  hotel_name: string | null;
  pax: number | string | null;
  /** operational pickup, already "HH:mm" or null (resolveOperationalTiming). */
  pickup_time: string | null;
  /** ora nave MEDMAR, already "HH:mm" or null. */
  vessel_time: string | null;
  booking_service_kind: string | null;
};

export type GeneratedConvocationStatus = "pronto" | "numero_non_valido" | "errore" | "escluso";

// Shape mirrors the `ConvocationRow` the /medmar-convocations preview table
// consumes (page.tsx), plus `service_id` as technical metadata (sprint §12).
export type GeneratedConvocationRow = {
  id: string;
  service_id: string;
  row_index: number;
  inviare: boolean;
  phone_raw: string;
  phone_e164: string | null;
  customer_name: string;
  travel_date: string;
  travel_date_iso: string | null;
  hotel: string;
  passengers: string;
  pickup_time: string;
  departure_time: string; // "ora nave" — same field name the preview table reads
  generated_message: string;
  status: GeneratedConvocationStatus;
  error_message: string | null;
  provider_message_id: null;
  sent_at: null;
};

export type GenerateSummary = {
  found: number;
  ready: number;
  toVerify: number;
  /** count per human-readable reason, for the "Da verificare" breakdown. */
  byReason: Record<string, number>;
};

type NormalizePhone = (raw: string) => string;

export function buildGeneratedConvocationRows(
  services: ServiceForConvocation[],
  dateIso: string,
  normalizePhone: NormalizePhone,
): { rows: GeneratedConvocationRow[]; summary: GenerateSummary } {
  const travelDateLabel = formatMedmarDepartureDate(dateIso);
  const byReason: Record<string, number> = {};
  const bump = (reason: string) => { byReason[reason] = (byReason[reason] ?? 0) + 1; };

  const rows = services.map((svc, i): GeneratedConvocationRow => {
    const customerName = (svc.customer_name ?? "").trim();
    const hotel = (svc.hotel_name ?? "").trim();
    const passengers = svc.pax == null ? "" : String(svc.pax).trim();
    const pickupTime = (svc.pickup_time ?? "").trim();
    const vesselTime = (svc.vessel_time ?? "").trim();
    const phoneRaw = (svc.phone ?? "").trim();

    const templateInput = {
      customerName,
      departureDateLabel: travelDateLabel,
      hotel,
      passengers,
      pickupTime,
      vesselTime,
    };
    // Built unconditionally, exactly like the Excel upload does.
    void buildMedmarConvocationTemplateParams(templateInput);
    const generatedMessage = buildMedmarConvocationPreviewText(templateInput);

    const base = {
      id: svc.service_id,
      service_id: svc.service_id,
      row_index: i + 1,
      inviare: true,
      phone_raw: phoneRaw,
      customer_name: customerName,
      travel_date: travelDateLabel,
      travel_date_iso: dateIso,
      hotel,
      passengers,
      pickup_time: pickupTime,
      departure_time: vesselTime,
      generated_message: generatedMessage,
      provider_message_id: null,
      sent_at: null,
    };

    const fail = (
      status: GeneratedConvocationStatus,
      message: string,
      phoneE164: string | null = null,
    ): GeneratedConvocationRow => {
      bump(message);
      return { ...base, phone_e164: phoneE164, status, error_message: message };
    };

    if (!customerName) return fail("errore", "Nome cliente mancante");
    if (!travelDateLabel) return fail("errore", "Data partenza mancante");
    if (!hotel) return fail("errore", "Hotel mancante");
    if (!passengers) return fail("errore", "Pax mancante");
    if (!pickupTime) return fail("errore", "Ora prelevamento mancante");
    if (!vesselTime) return fail("errore", "Ora nave mancante");
    if (!phoneRaw) return fail("numero_non_valido", "Numero cliente mancante");

    let phoneE164: string;
    try {
      phoneE164 = normalizePhone(phoneRaw);
    } catch (err) {
      return fail("numero_non_valido", err instanceof Error ? err.message : "Numero non valido");
    }

    return { ...base, phone_e164: phoneE164, status: "pronto", error_message: null };
  });

  const ready = rows.filter((r) => r.status === "pronto").length;
  return {
    rows,
    summary: {
      found: rows.length,
      ready,
      toVerify: rows.length - ready,
      byReason,
    },
  };
}
