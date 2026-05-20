import { describe, expect, it } from "vitest";
import { detectExcursionRoundtripClusters, serviceBelongsToExcursionRoundtripCluster } from "@/lib/piano-excursion-roundtrip-cluster";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";

const services = [
  {
    id: "mortella-out-re",
    time: "14:30",
    customer_name: "POLILLO",
    pax: 4,
    booking_service_kind: "excursion",
    service_type_code: "excursion",
    service_type: "bus_tour",
    excursion_details: { from: "RE FERDINANDO", to: "MORTELLA" },
  },
  {
    id: "mortella-out-cristallo",
    time: "14:50",
    customer_name: "CAM 335",
    pax: 1,
    booking_service_kind: "excursion",
    service_type_code: "excursion",
    service_type: "bus_tour",
    excursion_details: { from: "CRISTALLO", to: "MORTELLA" },
  },
  {
    id: "mortella-return-cristallo",
    time: "17:15",
    customer_name: "CAM 335",
    pax: 1,
    booking_service_kind: "excursion",
    service_type_code: "excursion",
    service_type: "bus_tour",
    excursion_details: { from: "MORTELLA", to: "CRISTALLO" },
  },
  {
    id: "mortella-return-re",
    time: "17:15",
    customer_name: "POLILLO",
    pax: 4,
    booking_service_kind: "excursion",
    service_type_code: "excursion",
    service_type: "bus_tour",
    excursion_details: { from: "MORTELLA", to: "RE FERDINANDO" },
  },
];

describe("excursion roundtrip clusters", () => {
  it("recognizes the Mortella outbound and return services as one cluster", () => {
    const clusters = detectExcursionRoundtripClusters({ services });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      type: "excursion_roundtrip_cluster",
      label: "ESCURSIONE MORTELLA",
      total_pax: 5,
      outbound_route: ["RE FERDINANDO", "CRISTALLO", "MORTELLA"],
      return_route: ["MORTELLA", "CRISTALLO", "RE FERDINANDO"],
    });
    expect(clusters[0]?.outbound_services.map((service) => service.service_id)).toEqual([
      "mortella-out-re",
      "mortella-out-cristallo",
    ]);
    expect(clusters[0]?.return_services.map((service) => service.service_id)).toEqual([
      "mortella-return-cristallo",
      "mortella-return-re",
    ]);
  });

  it("does not treat CAM 335 as an isolated movable service", () => {
    const clusters = detectExcursionRoundtripClusters({ services });

    expect(serviceBelongsToExcursionRoundtripCluster("mortella-out-cristallo", clusters)).toBe(true);
    expect(serviceBelongsToExcursionRoundtripCluster("mortella-return-cristallo", clusters)).toBe(true);
  });

  it("allows relocation only when the driver covers both outbound and return windows", () => {
    const leoOutbound = canDriverCoverInterval(
      { available: true, available_from: "16:00", available_to: "22:30" },
      { start_time: "14:30", end_time: "15:20" },
      { missingAvailability: "blocker" }
    );
    const leoReturn = canDriverCoverInterval(
      { available: true, available_from: "16:00", available_to: "22:30" },
      { start_time: "17:15", end_time: "17:45" },
      { missingAvailability: "blocker" }
    );
    const fullDayDriverOutbound = canDriverCoverInterval(
      { available: true, available_from: "14:00", available_to: "18:30" },
      { start_time: "14:30", end_time: "15:20" },
      { missingAvailability: "blocker" }
    );
    const fullDayDriverReturn = canDriverCoverInterval(
      { available: true, available_from: "14:00", available_to: "18:30" },
      { start_time: "17:15", end_time: "17:45" },
      { missingAvailability: "blocker" }
    );

    expect(leoOutbound.allowed).toBe(false);
    expect(leoReturn.allowed).toBe(true);
    expect(fullDayDriverOutbound.allowed && fullDayDriverReturn.allowed).toBe(true);
  });

  it("keeps GPR Peter as a whole service outside the Mortella cluster", () => {
    const clusters = detectExcursionRoundtripClusters({
      services: [
        ...services,
        {
          id: "gpr-peter",
          time: "15:00",
          customer_name: "GPR PETER",
          pax: 21,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "PARCO AURORA", to: "MORTELLA" },
        },
      ],
    });

    expect(serviceBelongsToExcursionRoundtripCluster("gpr-peter", clusters)).toBe(false);
    expect(clusters[0]?.total_pax).toBe(5);
  });
});
