/**
 * Label dinamica per tipo servizio agenzia.
 * Usata in email, pagina approvazione, lista prenotazioni.
 */

export type AgencyBookingKind =
  | "transfer_port_hotel"
  | "transfer_airport_hotel"
  | "transfer_airport_hotel_exclusive"
  | "transfer_airport_hotel_aliscafo"
  | "transfer_train_hotel"
  | "transfer_train_hotel_exclusive"
  | "transfer_train_hotel_aliscafo"
  | "bus_city_hotel"
  | "excursion"
  | "formula_snav"
  | "formula_medmar_napoli"
  | "formula_medmar_pozzuoli";

export interface ServiceLabelContext {
  kind: AgencyBookingKind;
  transportCode?: string | null;
  busCityOrigin?: string | null;
  excursionTitle?: string | null;
  hotelName?: string | null;
}

export function buildServiceLabel(ctx: ServiceLabelContext): string {
  const hotel = ctx.hotelName ? ` → ${ctx.hotelName}` : "";
  switch (ctx.kind) {
    case "transfer_airport_hotel": {
      const flight = ctx.transportCode?.trim() ? ` · Volo ${ctx.transportCode.trim()}` : "";
      return `Transfer Aeroporto${hotel}${flight}`;
    }
    case "transfer_airport_hotel_exclusive": {
      const flight = ctx.transportCode?.trim() ? ` · Volo ${ctx.transportCode.trim()}` : "";
      return `Transfer Aeroporto Esclusivo${hotel}${flight}`;
    }
    case "transfer_airport_hotel_aliscafo": {
      const flight = ctx.transportCode?.trim() ? ` · Volo ${ctx.transportCode.trim()}` : "";
      return `Transfer Aeroporto Aliscafo${hotel}${flight}`;
    }
    case "transfer_train_hotel": {
      const train = ctx.transportCode?.trim() ? ` · ${ctx.transportCode.trim()}` : "";
      return `Transfer Stazione${hotel}${train}`;
    }
    case "transfer_train_hotel_exclusive": {
      const train = ctx.transportCode?.trim() ? ` · ${ctx.transportCode.trim()}` : "";
      return `Transfer Stazione Esclusivo${hotel}${train}`;
    }
    case "transfer_train_hotel_aliscafo": {
      const train = ctx.transportCode?.trim() ? ` · ${ctx.transportCode.trim()}` : "";
      return `Transfer Stazione Aliscafo${hotel}${train}`;
    }
    case "transfer_port_hotel":
      return `Transfer Porto${hotel}`;
    case "bus_city_hotel": {
      const city = ctx.busCityOrigin?.trim() ? ` da ${ctx.busCityOrigin.trim()}` : "";
      return `Bus${city}${hotel}`;
    }
    case "excursion": {
      const title = ctx.excursionTitle?.trim() ? `: ${ctx.excursionTitle.trim()}` : "";
      return `Escursione${title}${hotel}`;
    }
    case "formula_snav":
      return `Formula SNAV${hotel}`;
    case "formula_medmar_napoli":
      return `Formula MEDMAR Napoli${hotel}`;
    case "formula_medmar_pozzuoli":
      return `Formula MEDMAR Pozzuoli${hotel}`;
  }
}

export function buildServiceLabelShort(ctx: Omit<ServiceLabelContext, "hotelName">): string {
  return buildServiceLabel({ ...ctx, hotelName: null });
}
