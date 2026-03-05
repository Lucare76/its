import type { Assignment, DemoState, Hotel, InboundEmail, Membership, Service, StatusEvent } from "@/lib/types";

export const demoTenantId = "11111111-1111-1111-1111-111111111111";

const zones: Hotel["zone"][] = [
  "Ischia Porto",
  "Ischia Ponte",
  "Casamicciola",
  "Lacco Ameno",
  "Forio",
  "Barano",
  "Serrara Fontana"
];

const vessels = ["Caremar", "Alilauro", "Medmar"];
const statuses: Service["status"][] = [
  ...Array(10).fill("new"),
  ...Array(10).fill("assigned"),
  ...Array(5).fill("partito"),
  ...Array(5).fill("arrivato"),
  ...Array(10).fill("completato")
];

const hotelNames = [
  "Grand Hotel Royal",
  "Hotel Terme Excelsior",
  "Villa Mediterranea",
  "Hotel Mare Blu",
  "Resort Bellavista",
  "Hotel Panorama",
  "Parco Aurora",
  "Hotel San Montano",
  "Hotel Belvedere",
  "Hotel Eden Park",
  "Boutique Hotel Corallo",
  "Hotel Le Querce",
  "Hotel Continental",
  "Hotel Central Park",
  "Hotel La Pergola",
  "Hotel Castiglione",
  "Hotel Miramare",
  "Hotel Don Pedro",
  "Hotel Sirena",
  "Hotel Villa Durrueli"
];

const firstNames = [
  "Luca",
  "Marco",
  "Giulia",
  "Francesca",
  "Alessandro",
  "Chiara",
  "Davide",
  "Sara",
  "Matteo",
  "Elena",
  "Andrea",
  "Valentina",
  "Roberto",
  "Martina",
  "Paolo",
  "Federica",
  "Stefano",
  "Laura",
  "Simone",
  "Anna"
];

const lastNames = [
  "Rossi",
  "Esposito",
  "Romano",
  "Bianchi",
  "Ricci",
  "Marino",
  "Greco",
  "Bruno",
  "Gallo",
  "Conti",
  "Costa",
  "Mancini",
  "Lombardi",
  "Moretti",
  "Barbieri",
  "Giordano",
  "Ferrara",
  "De Luca",
  "Rinaldi",
  "Caruso"
];

export const demoMemberships: Membership[] = [
  { user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", tenant_id: demoTenantId, role: "admin", full_name: "Admin Demo" },
  { user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", tenant_id: demoTenantId, role: "operator", full_name: "Operator Demo" },
  { user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3", tenant_id: demoTenantId, role: "agency", full_name: "Agency Demo" },
  { user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4", tenant_id: demoTenantId, role: "driver", full_name: "Giovanni Esposito" },
  { user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5", tenant_id: demoTenantId, role: "driver", full_name: "Marco Ferrara" }
];

export const demoHotels: Hotel[] = Array.from({ length: 80 }, (_, index) => {
  const zone = zones[index % zones.length];
  const base = hotelNames[index % hotelNames.length];
  return {
    id: `20000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    tenant_id: demoTenantId,
    name: `${base} ${zone}`,
    address: `Via Demo ${20 + index}, ${zone}`,
    lat: 40.7 + (index % 16) * 0.005,
    lng: 13.83 + (index % 14) * 0.009,
    zone
  };
});

export const demoServicesToday: Service[] = Array.from({ length: 40 }, (_, index) => {
  const status = statuses[index] as Service["status"];
  const serviceType: Service["service_type"] = index % 8 === 0 ? "bus_tour" : "transfer";
  return {
    id: `30000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    tenant_id: demoTenantId,
    date: new Date().toISOString().slice(0, 10),
    time: `${String(7 + (index % 14)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}`,
    service_type: serviceType,
    direction: index % 2 === 0 ? "departure" : "arrival",
    vessel: vessels[index % vessels.length],
    pax: 1 + (index % 6),
    hotel_id: demoHotels[index % demoHotels.length].id,
    customer_name: `${firstNames[index % firstNames.length]} ${lastNames[(index * 3) % lastNames.length]}`,
    phone: `+39 3${String(300000000 + index * 137).padStart(9, "0")}`,
    notes: index % 4 === 0 ? "Bagagli extra" : "Nessuna nota",
    tour_name: serviceType === "bus_tour" ? "Tour Ischia Full Day" : null,
    capacity: serviceType === "bus_tour" ? 18 : null,
    meeting_point: serviceType === "bus_tour" ? "Piazza Marina, Ischia Porto" : null,
    stops: serviceType === "bus_tour" ? ["Castello Aragonese", "Forio Centro", "Sant Angelo"] : [],
    bus_plate: serviceType === "bus_tour" ? "IS 900 BT" : null,
    status
  };
});

export const demoAssignments: Assignment[] = demoServicesToday
  .slice(10)
  .map((service, index) => ({
    id: `50000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    tenant_id: demoTenantId,
    service_id: service.id,
    driver_user_id: index % 2 === 0 ? demoMemberships[3].user_id : demoMemberships[4].user_id,
    vehicle_label: index % 2 === 0 ? "Mercedes Vito - AA123BB" : "Ford Tourneo - CC456DD",
    created_at: new Date(Date.now() - (30 - index) * 45_000).toISOString()
  }));

export const demoStatusEvents: StatusEvent[] = demoServicesToday.map((service, index) => ({
  id: `60000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
  service_id: service.id,
  status: service.status,
  at: new Date(Date.now() - (40 - index) * 60_000).toISOString(),
  by_user_id: index % 2 === 0 ? demoMemberships[1].user_id : demoMemberships[3].user_id,
  tenant_id: demoTenantId
}));

export const demoInboundEmails: InboundEmail[] = [
  {
    id: "70000000-0000-0000-0000-000000000001",
    tenant_id: demoTenantId,
    raw_text: "DATA 2026-03-02 ORA 14:30 NAVE Caremar HOTEL Grand Hotel Royal Ischia Porto PAX 4 NOME Mario Rossi",
    parsed_json: {
      date: "2026-03-02",
      time: "14:30",
      vessel: "Caremar",
      hotel: "Grand Hotel Royal Ischia Porto",
      pax: 4,
      customer_name: "Mario Rossi"
    },
    created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
  }
];

export const initialDemoState: DemoState = {
  hotels: demoHotels,
  services: demoServicesToday,
  assignments: demoAssignments,
  statusEvents: demoStatusEvents,
  inboundEmails: demoInboundEmails,
  memberships: demoMemberships
};
