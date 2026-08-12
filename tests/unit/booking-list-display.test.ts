import { describe, expect, it } from "vitest";
import { bookingListTransportTimes } from "@/lib/booking-list-display";

describe("bookingListTransportTimes", () => {
  it("mostra gli orari treno e non il pickup", () => {
    expect(bookingListTransportTimes({
      booking_service_kind: "transfer_train_hotel",
      time: "12:00",
      arrival_time: "10:30",
      departure_time: "18:20",
      train_arrival_time: "10:25",
      train_departure_time: "18:15",
    })).toMatchObject({ outwardTime: "10:25", returnTime: "18:15" });
  });

  it("mostra le partenze nave andata e ritorno per MEDMAR", () => {
    expect(bookingListTransportTimes({
      booking_service_kind: "formula_medmar_napoli",
      time: "08:40",
      arrival_time: "10:05",
      departure_time: "17:30",
      train_arrival_time: null,
      train_departure_time: null,
    })).toMatchObject({ outwardTime: "08:40", returnTime: "17:30" });
  });
});
