// SPRINT SNAV — "Genera dal gestionale" for SNAV convocations.
// Mirrors lib/medmar-generate-from-services.ts field-for-field (same
// validation ladder, same row shape) but self-contained so SNAV never
// depends on the MEDMAR module and the two domains can't drift each other.
//
// Pure mapping/validation: turns SNAV departure services (already read from
// the DB and pre-resolved by the route) into rows byte-compatible with what
// the SNAV Excel upload produces, so the SAME preview table renders them
// unchanged. No DB access, no WhatsApp, no side effects.

import {
  buildSnavConvocationTemplateParams,
  buildSnavConvocationPreviewText,
} from "@/lib/snav-convocation-template";
import { formatSnavDepartureDate } from "@/lib/snav-convocation-format";

export const SNAV_DEPARTURE_KINDS = ["formula_snav"] as const;

export type SnavDepartureKind = (typeof SNAV_DEPARTURE_KINDS)[number];

export function isSnavDepartureKind(kind: string | null | undefined): boolean {
  return kind != null && (SNAV_DEPARTURE_KINDS as readonly string[]).includes(kind);
}

// A service already flattened + timing-resolved by the route.
export type ServiceForSnavConvocation = {
  service_id: string;
  customer_name: string | null;
  phone: string | null;
  hotel_name: string | null;
  pax: number | string | null;
  /** operational pickup, already "HH:mm" or null. */
  pickup_time: string | null;
  /** ora SNAV, already "HH:mm" or null. */
  vessel_time: string | null;
  booking_service_kind: string | null;
};

export type GeneratedSnavConvocationStatus = "pronto" | "numero_non_valido" | "errore" | "escluso";

// Shape mirrors the `ConvocationRow` the /snav-convocations preview table
// consumes (page.tsx), plus `service_id` as technical metadata.
export type GeneratedSnavConvocationRow = {
  id: string;
  service_id: string;
  row_index: number;
  inviare: boolean;
  phone_raw: string;
  phone_e164: string | null;
  customer_name: string;
  departure_date_label: string;
  departure_date_iso: string | null;
  hotel: string;
  passengers: string;
  pickup_time: string;
  vessel_time: string;
  generated_message: string;
  status: GeneratedSnavConvocationStatus;
  error_message: string | null;
  provider_message_id: null;
  sent_at: null;
};

export type GenerateSnavSummary = {
  found: number;
  ready: number;
  toVerify: number;
  byReason: Record<string, number>;
};

type NormalizePhone = (raw: string) => string;

export function buildGeneratedSnavConvocationRows(
  services: ServiceForSnavConvocation[],
  dateIso: string,
  normalizePhone: NormalizePhone,
): { rows: GeneratedSnavConvocationRow[]; summary: GenerateSnavSummary } {
  const departureDateLabel = formatSnavDepartureDate(dateIso);
  const byReason: Record<string, number> = {};
  const bump = (reason: string) => { byReason[reason] = (byReason[reason] ?? 0) + 1; };

  const rows = services.map((svc, i): GeneratedSnavConvocationRow => {
    const customerName = (svc.customer_name ?? "").trim();
    const hotel = (svc.hotel_name ?? "").trim();
    const passengers = svc.pax == null ? "" : String(svc.pax).trim();
    const pickupTime = (svc.pickup_time ?? "").trim();
    const vesselTime = (svc.vessel_time ?? "").trim();
    const phoneRaw = (svc.phone ?? "").trim();

    const templateInput = {
      customerName,
      departureDateLabel,
      hotel,
      passengers,
      pickupTime,
      vesselTime,
    };
    void buildSnavConvocationTemplateParams(templateInput);
    const generatedMessage = buildSnavConvocationPreviewText(templateInput);

    const base = {
      id: svc.service_id,
      service_id: svc.service_id,
      row_index: i + 1,
      inviare: true,
      phone_raw: phoneRaw,
      customer_name: customerName,
      departure_date_label: departureDateLabel,
      departure_date_iso: dateIso,
      hotel,
      passengers,
      pickup_time: pickupTime,
      vessel_time: vesselTime,
      generated_message: generatedMessage,
      provider_message_id: null,
      sent_at: null,
    };

    const fail = (
      status: GeneratedSnavConvocationStatus,
      message: string,
      phoneE164: string | null = null,
    ): GeneratedSnavConvocationRow => {
      bump(message);
      return { ...base, phone_e164: phoneE164, status, error_message: message };
    };

    if (!customerName) return fail("errore", "Nome cliente mancante");
    if (!departureDateLabel) return fail("errore", "Data partenza mancante");
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
