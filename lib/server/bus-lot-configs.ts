import { deriveBusLotTitle } from "@/lib/bus-lot-utils";

type AdminClient = {
  from: (table: string) => {
    upsert: (payload: unknown, options?: { onConflict?: string }) => Promise<{ error: { message: string } | null }>;
  };
};

type BusLotSeed = {
  tenantId: string;
  date: string;
  direction: "arrival" | "departure";
  billingPartyName?: string | null;
  busCityOrigin?: string | null;
  transportCode?: string | null;
  title?: string | null;
  meetingPoint?: string | null;
};

function normalizeLotPart(value?: string | null) {
  return value?.trim().toLowerCase() || "n-d";
}

export function buildBusLotKeyFromSeed(seed: BusLotSeed) {
  return [
    seed.date,
    seed.direction,
    normalizeLotPart(seed.billingPartyName),
    normalizeLotPart(seed.busCityOrigin),
    normalizeLotPart(seed.transportCode)
  ].join("|");
}

export async function ensureDefaultBusLotConfig(admin: AdminClient, seed: BusLotSeed) {
  const lot_key = buildBusLotKeyFromSeed(seed);
  const title = deriveBusLotTitle({
    title: seed.title,
    transportCode: seed.transportCode,
    busCityOrigin: seed.busCityOrigin,
    meetingPoint: seed.meetingPoint
  });
  const { error } = await admin.from("bus_lot_configs").upsert(
    {
      tenant_id: seed.tenantId,
      lot_key,
      service_date: seed.date,
      direction: seed.direction,
      billing_party_name: seed.billingPartyName ?? null,
      bus_city_origin: seed.busCityOrigin ?? null,
      transport_code: seed.transportCode ?? null,
      title,
      meeting_point: seed.meetingPoint ?? null,
      capacity: 54,
      low_seat_threshold: 5,
      minimum_passengers: null,
      waitlist_enabled: false,
      waitlist_count: 0,
      notes: null
    },
    { onConflict: "tenant_id,lot_key" }
  );

  if (error) {
    throw new Error(error.message);
  }

  return lot_key;
}
