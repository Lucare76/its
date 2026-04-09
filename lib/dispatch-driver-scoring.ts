import type { Assignment, Hotel, Membership, Service } from "@/lib/types";

export interface DriverSuggestion {
  userId: string;
  fullName: string;
  score: number;
  assignedToday: number;
  availabilityScore: number;
  loadScore: number;
  proximityScore: number;
  reasons: string[];
}

interface ScoringInput {
  drivers: Membership[];
  assignments: Assignment[];
  services: Service[];
  hotels: Hotel[];
  selectedService: Service | null;
}

function parseMinutes(rawTime: string) {
  const [hourRaw = "0", minuteRaw = "0"] = rawTime.slice(0, 5).split(":");
  return Number(hourRaw) * 60 + Number(minuteRaw);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthKm * c;
}

export function calculateDriverSuggestions({ drivers, assignments, services, hotels, selectedService }: ScoringInput): DriverSuggestion[] {
  if (!selectedService) return [];

  const hotelsById = new Map(hotels.map((hotel) => [hotel.id, hotel]));
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const selectedHotel = hotelsById.get(selectedService.hotel_id);
  const targetMinutes = parseMinutes(selectedService.time);

  return drivers
    .map((driver) => {
      const driverAssignments = assignments.filter((assignment) => assignment.driver_user_id === driver.user_id);
      const todayServices = driverAssignments
        .map((assignment) => servicesById.get(assignment.service_id))
        .filter((service): service is Service => Boolean(service))
        .filter((service) => service.date === selectedService.date);

      const assignedToday = todayServices.length;
      const activeJobs = todayServices.filter((service) => service.status === "partito" || service.status === "arrivato").length;
      const latestService = [...todayServices].sort((a, b) => b.time.localeCompare(a.time))[0] ?? null;
      const latestHotel = latestService ? hotelsById.get(latestService.hotel_id) ?? null : null;

      const closeTimeOpenJobs = todayServices.filter((service) => {
        if (service.status === "completato" || service.status === "cancelled") return false;
        const gap = Math.abs(targetMinutes - parseMinutes(service.time));
        return gap <= 90;
      }).length;

      const reasons: string[] = [];

      let availabilityScore = 0;
      if (activeJobs === 0) {
        availabilityScore += 25;
        reasons.push("Disponibile ora");
      } else {
        availabilityScore -= 18 * activeJobs;
        reasons.push(`${activeJobs} job in corso`);
      }
      if (closeTimeOpenJobs === 0) {
        availabilityScore += 10;
        reasons.push("Nessun conflitto orario +/-90 min");
      } else {
        availabilityScore -= 10 * closeTimeOpenJobs;
        reasons.push(`${closeTimeOpenJobs} servizio vicino all'orario pickup`);
      }

      const loadScore = Math.max(0, 30 - assignedToday * 6);
      reasons.push(`${assignedToday} assegnazioni oggi`);

      let proximityScore = 8;
      if (selectedHotel && latestHotel) {
        if (selectedHotel.id === latestHotel.id) {
          proximityScore = 35;
          reasons.push(`Ultimo servizio stesso hotel (${selectedHotel.name})`);
        } else if (selectedHotel.zone === latestHotel.zone) {
          proximityScore = 24;
          reasons.push(`Stessa zona (${selectedHotel.zone})`);
        } else {
          const distanceKm = haversineKm(selectedHotel.lat, selectedHotel.lng, latestHotel.lat, latestHotel.lng);
          proximityScore = Math.max(6, Math.round(18 - Math.min(distanceKm, 12)));
          reasons.push(`Distanza stimata da ultimo hotel: ${distanceKm.toFixed(1)} km`);
        }
      } else {
        reasons.push("Prossimita hotel non disponibile");
      }

      const score = availabilityScore + loadScore + proximityScore;

      return {
        userId: driver.user_id,
        fullName: driver.full_name,
        score,
        assignedToday,
        availabilityScore,
        loadScore,
        proximityScore,
        reasons
      };
    })
    .sort((a, b) => b.score - a.score || a.assignedToday - b.assignedToday || a.fullName.localeCompare(b.fullName));
}
