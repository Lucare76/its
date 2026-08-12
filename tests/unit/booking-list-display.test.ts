import { describe, expect, it } from "vitest";
import { bookingListTransportTimes } from "@/lib/booking-list-display";

describe("bookingListTransportTimes", () => {
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

  it("mostra le partenze nave andata e ritorno per MEDMAR", () => {
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
    })).toMatchObject({ outwardDate: "01/09/2026", outwardTime: "08:40", returnDate: "08/09/2026", returnTime: "19:10" });
  });
});
