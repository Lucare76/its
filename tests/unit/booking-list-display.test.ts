import { describe, expect, it } from "vitest";
import { bookingListTransportTimes } from "@/lib/booking-list-display";

describe("bookingListTransportTimes", () => {
  it("prenotazione importata via IMAP+Claude (fix inbox-approve): la card mostra gli stessi dati del flusso manuale", () => {
    // Forma esatta scritta da app/api/email/inbox-approve/route.ts dopo il fix
    // (nessun train_arrival_time/train_departure_time: solo i campi generici
    // arrival_time/departure_time, che devono bastare via fallback).
    expect(bookingListTransportTimes({
      booking_service_kind: "transfer_train_hotel",
      date: "2026-08-30",
      time: "13:43",
      arrival_date: "2026-08-30",
      arrival_time: "13:43",
      departure_date: "2026-09-06",
      departure_time: "13:20",
    })).toMatchObject({
      outwardDate: "30/08/2026",
      outwardTime: "13:43",
      returnDate: "06/09/2026",
      returnTime: "13:20",
    });
  });

  it("import con solo arrivo: PARTENZA resta '—' (null) senza generare orari inventati", () => {
    expect(bookingListTransportTimes({
      booking_service_kind: "transfer_train_hotel",
      date: "2026-08-30",
      time: "13:43",
      arrival_date: "2026-08-30",
      arrival_time: "13:43",
      departure_date: null,
      departure_time: null,
    })).toMatchObject({
      outwardDate: "30/08/2026",
      outwardTime: "13:43",
      returnDate: null,
      returnTime: null,
    });
  });

  it("mostra gli orari treno e non il pickup", () => {
    expect(bookingListTransportTimes({
      booking_service_kind: "transfer_train_hotel",
      arrival_date: "2026-08-12",
      departure_date: "2026-08-19",
      time: "12:00",
      arrival_time: "10:30",
      departure_time: "18:20",
      train_arrival_time: "10:25",
      train_departure_time: "18:15",
    })).toMatchObject({ outwardDate: "12/08/2026", outwardTime: "10:25", returnDate: "19/08/2026", returnTime: "18:15" });
  });

  describe("direction gate su transfer_train_hotel/airport/bus (fix: bug BIRAGO)", () => {
    it("direction='departure' con arrival_date/arrival_time residui (bug form 'Solo partenza'): nasconde comunque l'andata", () => {
      // Dati reali della prenotazione ANNAMARIA BIRAGO prima del fix: il form
      // "Solo partenza" copiava i default (oggi, 18:00) nei campi arrivo
      // invece di svuotarli — qui verifichiamo che la card non li mostri MAI
      // per una riga direction='departure', anche se il DB li contiene ancora.
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_train_hotel",
        direction: "departure",
        date: "2026-08-27",
        time: "12:10",
        arrival_date: "2026-08-26",
        arrival_time: "18:00",
        departure_date: "2026-08-27",
        departure_time: "12:10",
      });
      expect(result).toMatchObject({
        outwardDate: null,
        outwardTime: null,
        returnDate: "27/08/2026",
        returnTime: "12:10",
      });
    });

    it("direction='arrival' con departure_date/departure_time residui: nasconde comunque il ritorno", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_airport_hotel",
        direction: "arrival",
        arrival_date: "2026-08-27",
        arrival_time: "10:00",
        departure_date: "2026-08-26",
        departure_time: "18:00",
      });
      expect(result).toMatchObject({
        outwardDate: "27/08/2026",
        outwardTime: "10:00",
        returnDate: null,
        returnTime: null,
      });
    });

    it("senza direction (dati storici): comportamento invariato, mostra entrambe le gambe", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_train_hotel",
        arrival_date: "2026-08-30",
        arrival_time: "13:43",
        departure_date: "2026-09-06",
        departure_time: "13:20",
      });
      expect(result).toMatchObject({
        outwardDate: "30/08/2026",
        outwardTime: "13:43",
        returnDate: "06/09/2026",
        returnTime: "13:20",
      });
    });
  });

  describe("transfer_port_hotel (fix: ramo prima assente, tornava null)", () => {
    it("con arrivo + partenza ma senza pickup calcolato: departure_time va su Partenza traghetto/aliscafo, MAI su Pickup hotel (dati reali STROZZI GIANLUCA prima del fix semantico)", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_port_hotel",
        date: "2026-08-30",
        time: "16:20",
        arrival_date: "2026-08-30",
        arrival_time: "16:20",
        departure_date: "2026-09-05",
        departure_time: "14:00",
        meeting_point: "PORTO NAPOLI",
        transport_code: "SNAV / SNAV",
      });
      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        outwardDate: "30/08/2026",
        outwardTime: "16:20",
        outwardPickupPoint: "PORTO NAPOLI",
        outwardCompany: "SNAV",
        returnDate: "05/09/2026",
        returnTime: "14:00",
        returnCompany: "SNAV",
      });
      // Nessun pickup_hotel/return_pickup_time calcolato per questa riga (legacy,
      // nessuna gamba di ritorno collegata): la card deve mostrare "—", MAI 14:00.
      expect(result?.returnPickupTime).toBeNull();
    });

    it("con departure_time = 14:00 (traghetto) e pickup hotel diverso (11:00, da return_pickup_time): la card distingue i due orari, nessun '—' su nessuno dei due", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_port_hotel",
        arrival_date: "2026-08-30",
        arrival_time: "16:20",
        departure_date: "2026-09-05",
        departure_time: "14:00",
        return_pickup_time: "11:00",
        meeting_point: "PORTO NAPOLI",
        transport_code: "SNAV / SNAV",
      });
      // Partenza traghetto/aliscafo: l'orario del traghetto (14:00), non il pickup.
      expect(result?.returnTime).toBe("14:00");
      // Pickup hotel: il vero orario di prelievo (11:00), mai uguale a departure_time.
      expect(result?.returnPickupTime).toBe("11:00");
      expect(result?.returnTime).not.toBe(result?.returnPickupTime);
    });

    it("con pickup hotel disponibile solo su pickup_hotel (calcPickupTime, nessun return_pickup_time): lo usa come fallback, non mostra '—'", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_port_hotel",
        arrival_date: "2026-08-30",
        arrival_time: "16:20",
        departure_date: "2026-09-05",
        departure_time: "14:00",
        pickup_hotel: "11:00",
        meeting_point: "PORTO NAPOLI",
      });
      expect(result?.returnTime).toBe("14:00");
      expect(result?.returnPickupTime).toBe("11:00");
    });

    it("orario_barca disponibile (traghetto calcolato): ha priorità su departure_time per Partenza traghetto/aliscafo", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_port_hotel",
        arrival_date: "2026-08-30",
        arrival_time: "16:20",
        departure_date: "2026-09-05",
        departure_time: "14:00",
        orario_barca: "13:45",
      });
      expect(result?.returnTime).toBe("13:45");
    });

    it("con solo arrivo (nessun ritorno confermato): PARTENZA resta null, nessuna compagnia di ritorno inventata", () => {
      const result = bookingListTransportTimes({
        booking_service_kind: "transfer_port_hotel",
        date: "2026-08-30",
        time: "16:20",
        arrival_date: "2026-08-30",
        arrival_time: "16:20",
        departure_date: null,
        departure_time: null,
        meeting_point: "PORTO NAPOLI",
        transport_code: "SNAV",
      });
      expect(result).toMatchObject({
        outwardDate: "30/08/2026",
        outwardTime: "16:20",
        outwardPickupPoint: "PORTO NAPOLI",
        outwardCompany: "SNAV",
        returnDate: null,
        returnPickupTime: null,
        returnCompany: null,
      });
    });

    it("nessun crash con oggetto minimale (nessun campo di partenza/pickup presente)", () => {
      expect(() =>
        bookingListTransportTimes({ booking_service_kind: "transfer_port_hotel", date: "2026-08-30" })
      ).not.toThrow();
      const result = bookingListTransportTimes({ booking_service_kind: "transfer_port_hotel", date: "2026-08-30" });
      expect(result).not.toBeNull();
      expect(result?.outwardDate).toBe("30/08/2026");
      expect(result?.returnDate).toBeNull();
    });
  });

  it("mostra partenza e arrivo nave all'andata, pickup e nave al ritorno", () => {
    expect(bookingListTransportTimes({
      booking_service_kind: "formula_medmar_napoli",
      arrival_date: "2026-09-01",
      departure_date: "2026-09-08",
      time: "08:40",
      arrival_time: "10:05",
      departure_time: "17:30",
      orario_barca: "19:10",
      train_arrival_time: null,
      train_departure_time: null,
      outbound_ferry_departure_time: "08:40",
      outbound_ferry_arrival_time: "10:05",
      return_pickup_time: "17:30",
      return_ferry_departure_time: "19:10",
    })).toMatchObject({
      outwardDate: "01/09/2026",
      outwardTime: "08:40",
      outwardArrivalTime: "10:05",
      returnDate: "08/09/2026",
      returnPickupTime: "17:30",
      returnTime: "19:10",
    });
  });
});
