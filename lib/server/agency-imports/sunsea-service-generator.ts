import type { MtsGlobeBookingDraft, MtsGlobeParsedLeg } from "@/lib/server/agency-imports/mts-globe-parser";

// SunSeaServiceGenerator: traduce un booking Sun&Sea normalizzato (COSA e'
// stato prenotato, dal parser) in uno o piu' service payload operativi
// (COME va eseguito). Separato di proposito dal parser: il parser non
// conosce hotel_id, il generator non legge mai l'Excel grezzo.
//
// `time` qui e' SEMPRE l'orario del volo/traghetto cosi' come presente in
// riga (arrTime per arrivo, depTime per partenza) — stessa convenzione di
// services.time in tutti gli altri canali ITS (agency-pdf-import.ts,
// excel/import): il campo "time" non e' mai l'orario operativo di pickup.
// Per le PARTENZE (hotel -> aeroporto), l'orario operativo di pickup
// dall'hotel/nave/porto NON viene calcolato qui: e' responsabilita' del
// chiamante (mts-globe-import.ts), che deve invocare il motore canonico
// condiviso lib/server/apply-pickup-calc.ts (applyPickupCalc), lo stesso
// usato da excel/import e new-booking — MAI una seconda logica Sun&Sea.
// I campi pickupHotel/barcaCompagnia/orarioBarca/portoBruno/pickupAlert
// restano null qui e vengono valorizzati dal chiamante.

export type ResolvedHotelForLeg = {
  legRowIndex: number;
  hotelId: string | null;
  matchConfidence: "matched" | "unmatched";
};

export type GeneratedServiceDraft = {
  legRowIndex: number;
  bookingServiceKind: "transfer_airport_hotel" | "transfer_hotel_hotel";
  serviceTypeCode: "transfer_airport_hotel" | "transfer_hotel_port";
  direction: "arrival" | "departure";
  date: string;
  time: string;
  pax: number;
  hotelId: string | null;
  hotelNameRaw: string | null;
  hotelToId: string | null; // solo hotel_change (secondo hotel)
  hotelToNameRaw: string | null;
  customerName: string;
  transportCode: string | null;
  vessel: string;
  meetingPoint: string | null;
  notes: string;
  warnings: string[];
  // Orario operativo di pickup/nave/porto per le partenze (hotel -> aeroporto),
  // calcolato dal chiamante via applyPickupCalc — mai qui. Sempre null per
  // arrivo e hotel_change (fuori dal dominio di quel motore).
  pickupHotel: string | null;
  barcaCompagnia: string | null;
  orarioBarca: string | null;
  portoBruno: string | null;
  pickupAlert: string | null;
};

function legVessel(leg: MtsGlobeParsedLeg): string {
  if (leg.legType === "hotel_change") return "Transfer hotel/hotel";
  const airport = leg.legType === "arrival" ? leg.depAirport : leg.arrAirport;
  return leg.flightCode ? `Volo ${leg.flightCode}${airport ? ` (${airport})` : ""}` : "Aeroporto Napoli";
}

function legTime(leg: MtsGlobeParsedLeg): string {
  if (leg.legType === "arrival") return leg.arrTime ?? "00:00";
  if (leg.legType === "departure") return leg.depTime ?? "00:00";
  // hotel_change (Intermedio): nel file reale Dep Time/Arr Time sono sempre
  // vuoti per queste righe, ma se un domani un file li valorizzasse (dato
  // reale in riga) vanno usati — mai un "00:00" inventato quando assenti,
  // vedi hotelChangeTimeMissing() sotto per il caso assente.
  return leg.depTime ?? leg.arrTime ?? "";
}

// true quando il leg Intermedio non porta alcun orario reale in riga: in
// questo caso il generator NON inventa un service.time, lascia "" e segnala
// un warning esplicito — la risoluzione (orario manuale) e' responsabilita'
// dell'operatore in preview (vedi mts-globe-import.ts, time corrections).
function hotelChangeTimeMissing(leg: MtsGlobeParsedLeg): boolean {
  return leg.legType === "hotel_change" && !leg.depTime && !leg.arrTime;
}

function legMeetingPoint(leg: MtsGlobeParsedLeg): string | null {
  if (leg.legType === "arrival") return leg.depAirport ? `Aeroporto ${leg.depAirport}` : "Aeroporto";
  if (leg.legType === "departure") return leg.arrAirport ? `Aeroporto ${leg.arrAirport}` : "Aeroporto";
  return null;
}

/**
 * Genera un service draft per ogni gamba della prenotazione. Non genera MAI
 * una gamba assente nei dati sorgente (es. "solo rientro" -> un solo
 * service): il numero di service == numero di leg parse-ate per quel
 * voucher (dopo dedup).
 */
export function generateSunSeaServices(
  booking: MtsGlobeBookingDraft,
  resolvedHotels: ResolvedHotelForLeg[]
): GeneratedServiceDraft[] {
  const hotelByRow = new Map(resolvedHotels.map((r) => [r.legRowIndex, r]));

  return booking.legs.map((leg): GeneratedServiceDraft => {
    const warnings: string[] = [];
    const primaryHotel = hotelByRow.get(leg.rowIndex) ?? null;

    if (leg.legType === "hotel_change") {
      // Per l'intermedio servono due risoluzioni hotel distinte: la mappa
      // resolvedHotels usa lo stesso rowIndex per entrambe (from/to), il
      // chiamante deve passare due entry sintetiche se vuole distinguerle;
      // qui usiamo primaryHotel come "from" e cerchiamo un'eventuale voce
      // dedicata con rowIndex negativo convenzionale per "to".
      const toHotel = hotelByRow.get(-leg.rowIndex) ?? null;
      if (!primaryHotel || primaryHotel.matchConfidence === "unmatched") {
        warnings.push(`Hotel origine non riconosciuto: "${leg.hotelFromRaw}".`);
      }
      if (!toHotel || toHotel.matchConfidence === "unmatched") {
        warnings.push(`Hotel destinazione non riconosciuto: "${leg.hotelToRaw}".`);
      }
      if (hotelChangeTimeMissing(leg)) {
        warnings.push("Orario transfer Intermedio mancante.");
      }
      return {
        legRowIndex: leg.rowIndex,
        bookingServiceKind: "transfer_hotel_hotel",
        serviceTypeCode: "transfer_hotel_port",
        direction: "departure",
        date: leg.date,
        time: legTime(leg),
        pax: leg.pax,
        hotelId: primaryHotel?.hotelId ?? null,
        hotelNameRaw: leg.hotelFromRaw,
        hotelToId: toHotel?.hotelId ?? null,
        hotelToNameRaw: leg.hotelToRaw,
        customerName: booking.customerName,
        transportCode: null,
        vessel: legVessel(leg),
        meetingPoint: null,
        notes: `Transfer hotel/hotel: ${leg.hotelFromRaw} -> ${leg.hotelToRaw}`,
        warnings,
        pickupHotel: null,
        barcaCompagnia: null,
        orarioBarca: null,
        portoBruno: null,
        pickupAlert: null
      };
    }

    if (!primaryHotel || primaryHotel.matchConfidence === "unmatched") {
      warnings.push(`Hotel non riconosciuto: "${leg.hotelNameRaw}".`);
    }

    return {
      legRowIndex: leg.rowIndex,
      bookingServiceKind: "transfer_airport_hotel",
      serviceTypeCode: "transfer_airport_hotel",
      direction: leg.legType === "arrival" ? "arrival" : "departure",
      date: leg.date,
      time: legTime(leg),
      pax: leg.pax,
      hotelId: primaryHotel?.hotelId ?? null,
      hotelNameRaw: leg.hotelNameRaw,
      hotelToId: null,
      hotelToNameRaw: null,
      customerName: booking.customerName,
      transportCode: leg.flightCode,
      vessel: legVessel(leg),
      meetingPoint: legMeetingPoint(leg),
      notes: [
        leg.flightCode ? `Volo ${leg.flightCode}` : null,
        leg.legType === "arrival" && leg.depAirport ? `Da ${leg.depAirport}` : null,
        leg.legType === "departure" && leg.arrAirport ? `Verso ${leg.arrAirport}` : null,
        leg.resort ? `Zona: ${leg.resort}` : null
      ]
        .filter(Boolean)
        .join(" | "),
      warnings,
      pickupHotel: null,
      barcaCompagnia: null,
      orarioBarca: null,
      portoBruno: null,
      pickupAlert: null
    };
  });
}
