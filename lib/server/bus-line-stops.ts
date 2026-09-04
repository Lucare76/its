import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeStopText } from "@/lib/server/bus-network-loader";

// PROMPT "Fermate bus" — Fase 8/9/10/12: UNA SOLA logica condivisa di
// creazione/modifica/eliminazione fermata (tenant_bus_line_stops), usata sia
// da /bus-stops sia da qualsiasi altro punto che deve creare/toccare una
// fermata canonica (es. create_stop_for_transfer). Mai una seconda
// implementazione parallela con regole diverse.

export type BusLineStopDirection = "arrival" | "departure";

export type BusLineStopRow = {
  id: string;
  tenant_id: string;
  bus_line_id: string;
  direction: BusLineStopDirection;
  stop_name: string;
  city: string;
  pickup_note: string | null;
  pickup_time: string | null;
  stop_order: number;
  lat: number | null;
  lng: number | null;
  is_manual: boolean;
  active: boolean;
};

export type NearDuplicateCandidate = { id: string; stopName: string; city: string };

function tokensOf(value: string) {
  return normalizeStopText(value).split(" ").filter(Boolean);
}

// Fase 9 — near duplicate (es. "ROMA - SAN CAMILLO" vs "SAN CAMILLO"): mai
// unire automaticamente, solo segnalare. Match per sottostringa normalizzata
// o token condivisi (>=4 caratteri, per evitare falsi positivi su parole
// corte come "DI"/"SAN"), mai una fuzzy-similarity generica.
export function findNearDuplicateStopNames(
  stopName: string,
  candidates: NearDuplicateCandidate[]
): NearDuplicateCandidate[] {
  const wanted = normalizeStopText(stopName);
  if (!wanted) return [];
  const wantedTokens = new Set(tokensOf(stopName).filter((t) => t.length >= 4));
  return candidates.filter((candidate) => {
    const candidateNorm = normalizeStopText(candidate.stopName);
    if (!candidateNorm || candidateNorm === wanted) return false; // exact match: gestito separatamente come blocco duro
    if (candidateNorm.includes(wanted) || wanted.includes(candidateNorm)) return true;
    return tokensOf(candidate.stopName).some((token) => token.length >= 4 && wantedTokens.has(token));
  });
}

export type CreateBusLineStopInput = {
  tenantId: string;
  busLineId: string;
  direction: BusLineStopDirection;
  stopName: string;
  city: string;
  pickupNote?: string | null;
  pickupTime?: string | null;
  stopOrder?: number | null;
  lat?: number | null;
  lng?: number | null;
};

export type CreateBusLineStopResult =
  | { ok: true; stop: BusLineStopRow; nearDuplicates: NearDuplicateCandidate[] }
  | { ok: false; reason: "duplicate"; existingStopId: string }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "db_error"; message: string };

// Fase 9 — anti-duplicato: match esatto su tenant_id + bus_line_id +
// direction + stop_name normalizzato -> BLOCCA sempre la creazione.
export async function createBusLineStop(
  admin: SupabaseClient,
  input: CreateBusLineStopInput
): Promise<CreateBusLineStopResult> {
  const stopName = input.stopName.trim().toUpperCase();
  const city = input.city.trim();
  if (!stopName || !city) {
    return { ok: false, reason: "invalid", message: "Nome fermata e città sono obbligatori." };
  }

  const { data: existingRows, error: existingErr } = await admin
    .from("tenant_bus_line_stops")
    .select("id,stop_name,city")
    .eq("tenant_id", input.tenantId)
    .eq("bus_line_id", input.busLineId)
    .eq("direction", input.direction);
  if (existingErr) return { ok: false, reason: "db_error", message: existingErr.message };

  const rows = (existingRows ?? []) as Array<{ id: string; stop_name: string; city: string }>;
  const normalizedWanted = normalizeStopText(stopName);
  const exactMatch = rows.find((row) => normalizeStopText(row.stop_name) === normalizedWanted);
  if (exactMatch) {
    return { ok: false, reason: "duplicate", existingStopId: exactMatch.id };
  }

  const nearDuplicates = findNearDuplicateStopNames(
    stopName,
    rows.map((row) => ({ id: row.id, stopName: row.stop_name, city: row.city }))
  );

  let stopOrder = input.stopOrder ?? undefined;
  if (!stopOrder || stopOrder < 1) {
    const { data: orderRows } = await admin
      .from("tenant_bus_line_stops")
      .select("stop_order")
      .eq("tenant_id", input.tenantId)
      .eq("bus_line_id", input.busLineId)
      .eq("direction", input.direction)
      .order("stop_order", { ascending: false })
      .limit(1);
    const maxOrder = ((orderRows ?? [])[0] as { stop_order?: number } | undefined)?.stop_order ?? 0;
    stopOrder = maxOrder + 1;
  }

  const { data: inserted, error: insertErr } = await admin
    .from("tenant_bus_line_stops")
    .insert({
      tenant_id: input.tenantId,
      bus_line_id: input.busLineId,
      direction: input.direction,
      stop_name: stopName,
      city,
      pickup_note: input.pickupNote?.trim() || null,
      pickup_time: input.pickupTime ?? null,
      stop_order: stopOrder,
      order_index: stopOrder,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      is_manual: true,
      active: true
    })
    .select("id,tenant_id,bus_line_id,direction,stop_name,city,pickup_note,pickup_time,stop_order,lat,lng,is_manual,active")
    .single();
  if (insertErr || !inserted) {
    return { ok: false, reason: "db_error", message: insertErr?.message ?? "Errore creazione fermata." };
  }

  return { ok: true, stop: inserted as BusLineStopRow, nearDuplicates };
}

export async function countBusLineStopUsage(admin: SupabaseClient, tenantId: string, stopId: string) {
  const { count, error } = await admin
    .from("tenant_bus_allocations")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("stop_id", stopId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export type UpdateBusLineStopInput = {
  tenantId: string;
  stopId: string;
  busLineId?: string;
  direction?: BusLineStopDirection;
  stopName?: string;
  city?: string;
  pickupNote?: string | null;
  pickupTime?: string | null;
  stopOrder?: number;
  lat?: number | null;
  lng?: number | null;
  active?: boolean;
};

export type UpdateBusLineStopResult =
  | { ok: true; stop: BusLineStopRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "line_direction_locked"; usageCount: number }
  | { ok: false; reason: "duplicate"; existingStopId: string }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "db_error"; message: string };

// Fase 10 — stop_id non cambia mai (è il PK, non un campo modificabile).
// Cambio linea/direzione su una fermata già in uso è bloccato: mai
// silenzioso, richiede prima di scollegare i servizi altrove.
export async function updateBusLineStop(
  admin: SupabaseClient,
  input: UpdateBusLineStopInput
): Promise<UpdateBusLineStopResult> {
  const { data: current, error: currentErr } = await admin
    .from("tenant_bus_line_stops")
    .select("id,tenant_id,bus_line_id,direction,stop_name,city,pickup_note,pickup_time,stop_order,lat,lng,is_manual,active")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.stopId)
    .maybeSingle();
  if (currentErr) return { ok: false, reason: "db_error", message: currentErr.message };
  if (!current) return { ok: false, reason: "not_found" };
  const row = current as BusLineStopRow;

  const wantsLineChange = input.busLineId !== undefined && input.busLineId !== row.bus_line_id;
  const wantsDirectionChange = input.direction !== undefined && input.direction !== row.direction;
  if (wantsLineChange || wantsDirectionChange) {
    const usageCount = await countBusLineStopUsage(admin, input.tenantId, input.stopId);
    if (usageCount > 0) {
      return { ok: false, reason: "line_direction_locked", usageCount };
    }
  }

  const nextBusLineId = input.busLineId ?? row.bus_line_id;
  const nextDirection = input.direction ?? row.direction;
  const nextStopName = (input.stopName ?? row.stop_name).trim().toUpperCase();
  const nextCity = (input.city ?? row.city).trim();
  if (!nextStopName || !nextCity) {
    return { ok: false, reason: "invalid", message: "Nome fermata e città sono obbligatori." };
  }

  const nameChanged = input.stopName !== undefined && normalizeStopText(nextStopName) !== normalizeStopText(row.stop_name);
  if (wantsLineChange || wantsDirectionChange || nameChanged) {
    const { data: siblings } = await admin
      .from("tenant_bus_line_stops")
      .select("id,stop_name")
      .eq("tenant_id", input.tenantId)
      .eq("bus_line_id", nextBusLineId)
      .eq("direction", nextDirection)
      .neq("id", input.stopId);
    const normalizedWanted = normalizeStopText(nextStopName);
    const exactMatch = ((siblings ?? []) as Array<{ id: string; stop_name: string }>).find(
      (s) => normalizeStopText(s.stop_name) === normalizedWanted
    );
    if (exactMatch) return { ok: false, reason: "duplicate", existingStopId: exactMatch.id };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.busLineId !== undefined) patch.bus_line_id = nextBusLineId;
  if (input.direction !== undefined) patch.direction = nextDirection;
  if (input.stopName !== undefined) patch.stop_name = nextStopName;
  if (input.city !== undefined) patch.city = nextCity;
  if (input.pickupNote !== undefined) patch.pickup_note = input.pickupNote?.trim() || null;
  if (input.pickupTime !== undefined) patch.pickup_time = input.pickupTime;
  if (input.stopOrder !== undefined) {
    patch.stop_order = input.stopOrder;
    patch.order_index = input.stopOrder;
  }
  if (input.lat !== undefined) patch.lat = input.lat;
  if (input.lng !== undefined) patch.lng = input.lng;
  if (input.active !== undefined) patch.active = input.active;

  const { data: updated, error: updateErr } = await admin
    .from("tenant_bus_line_stops")
    .update(patch)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.stopId)
    .select("id,tenant_id,bus_line_id,direction,stop_name,city,pickup_note,pickup_time,stop_order,lat,lng,is_manual,active")
    .single();
  if (updateErr || !updated) {
    return { ok: false, reason: "db_error", message: updateErr?.message ?? "Errore aggiornamento fermata." };
  }
  return { ok: true, stop: updated as BusLineStopRow };
}

export type DeleteBusLineStopResult =
  | { ok: true }
  | { ok: false; reason: "in_use"; usageCount: number }
  | { ok: false; reason: "db_error"; message: string };

// Fase 12 — mai eliminazione fisica se referenziata da tenant_bus_allocations.
export async function deleteBusLineStop(
  admin: SupabaseClient,
  tenantId: string,
  stopId: string
): Promise<DeleteBusLineStopResult> {
  const usageCount = await countBusLineStopUsage(admin, tenantId, stopId);
  if (usageCount > 0) return { ok: false, reason: "in_use", usageCount };
  const { error } = await admin.from("tenant_bus_line_stops").delete().eq("tenant_id", tenantId).eq("id", stopId);
  if (error) return { ok: false, reason: "db_error", message: error.message };
  return { ok: true };
}

export type BusLineStopWithUsage = BusLineStopRow & { service_count: number };

// Fase B — usata sia da "list_bus_line_stops" sia dopo reorder/normalizza,
// così /bus-stops riceve sempre lo stesso payload (fermate + conteggio
// servizi collegati) da un'unica fonte, mai due query duplicate divergenti.
export async function listBusLineStopsWithUsage(
  admin: SupabaseClient,
  tenantId: string
): Promise<BusLineStopWithUsage[]> {
  const [stopsRes, allocRes] = await Promise.all([
    admin
      .from("tenant_bus_line_stops")
      .select("id,tenant_id,bus_line_id,direction,stop_name,city,pickup_note,pickup_time,stop_order,lat,lng,is_manual,active")
      .eq("tenant_id", tenantId),
    admin.from("tenant_bus_allocations").select("stop_id").eq("tenant_id", tenantId),
  ]);
  if (stopsRes.error) throw new Error(stopsRes.error.message);
  if (allocRes.error) throw new Error(allocRes.error.message);

  const serviceCountByStopId = new Map<string, number>();
  for (const row of (allocRes.data ?? []) as Array<{ stop_id: string | null }>) {
    if (!row.stop_id) continue;
    serviceCountByStopId.set(row.stop_id, (serviceCountByStopId.get(row.stop_id) ?? 0) + 1);
  }
  return ((stopsRes.data ?? []) as BusLineStopRow[]).map((stop) => ({
    ...stop,
    service_count: serviceCountByStopId.get(stop.id) ?? 0,
  }));
}

export type ReorderBusLineStopsInput = {
  tenantId: string;
  busLineId: string;
  direction: BusLineStopDirection;
  orderedStopIds: string[];
};

export type ReorderResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "duplicate_ids" }
  | { ok: false; reason: "rpc_error"; message: string };

// Fase B/1/2 — reorder reale via RPC atomica `reorder_bus_line_stops`
// (supabase/migrations/0038_bus_booking_centric_reorder_and_audit.sql): la
// RPC gira in un'unica transazione Postgres e valida lato SQL che OGNI id
// appartenga a tenant_id+bus_line_id+direction, poi riscrive stop_order in
// blocco 1..N nell'ordine ricevuto. Qui si applicano solo le guardie che
// conviene dare in JS con un messaggio leggibile PRIMA di chiamare la RPC
// (lista vuota, id duplicati) — mai una sequenza di update client-side
// senza guardie: la scrittura vera è sempre e solo questa RPC.
export async function reorderBusLineStops(
  admin: SupabaseClient,
  input: ReorderBusLineStopsInput
): Promise<ReorderResult> {
  if (input.orderedStopIds.length === 0) return { ok: false, reason: "empty" };
  if (new Set(input.orderedStopIds).size !== input.orderedStopIds.length) {
    return { ok: false, reason: "duplicate_ids" };
  }
  const { error } = await admin.rpc("reorder_bus_line_stops", {
    p_tenant_id: input.tenantId,
    p_bus_line_id: input.busLineId,
    p_direction: input.direction,
    p_stop_ids: input.orderedStopIds,
  });
  if (error) return { ok: false, reason: "rpc_error", message: error.message };
  return { ok: true };
}

// Fase B/3 — ordinamento deterministico puro: stop_order crescente, poi id
// come tie-break stabile (mai l'ordine di iterazione del DB, non garantito).
// Opera SOLO sul sottoinsieme passato dal chiamante (una linea+direzione per
// volta) — mai una normalizzazione globale implicita su tutto il catalogo.
export function normalizeBusStopOrder(stops: Array<{ id: string; stop_order: number }>): string[] {
  return [...stops]
    .sort((a, b) => a.stop_order - b.stop_order || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

// Fase B/3 — normalizzazione ESPLICITA (mai automatica/globale): riscrive
// 1..N solo le fermate ATTIVE di UNA linea+direzione, riusando la stessa RPC
// atomica di reorderBusLineStops (nessun secondo percorso di scrittura).
export async function normalizeBusLineStopOrder(
  admin: SupabaseClient,
  tenantId: string,
  busLineId: string,
  direction: BusLineStopDirection
): Promise<ReorderResult> {
  const { data, error } = await admin
    .from("tenant_bus_line_stops")
    .select("id,stop_order")
    .eq("tenant_id", tenantId)
    .eq("bus_line_id", busLineId)
    .eq("direction", direction)
    .eq("active", true);
  if (error) return { ok: false, reason: "rpc_error", message: error.message };

  const rows = (data ?? []) as Array<{ id: string; stop_order: number }>;
  if (rows.length === 0) return { ok: true };

  const orderedStopIds = normalizeBusStopOrder(rows);
  return reorderBusLineStops(admin, { tenantId, busLineId, direction, orderedStopIds });
}

export type GeocodeCityFn = (city: string) => Promise<{ lat: number; lng: number } | null>;

export type CreateStopForTransferInput = {
  tenantId: string;
  busLineId: string;
  direction: BusLineStopDirection;
  stopName: string;
};

export type CreateStopForTransferResult =
  | { ok: true; stopId: string }
  | { ok: false; message: string };

// Fase B/4 — core unificato di create_stop_for_transfer: la logica
// GEOGRAFICA (ordinamento per lat/lng rispetto alle fermate esistenti, con
// shift dei stop_order successivi quando si inserisce in mezzo) resta
// specifica di questo caller, ma la creazione/anti-duplicato vera e propria
// passa SEMPRE da createBusLineStop — stessa regola di /bus-stops, mai un
// secondo insert diretto con controlli diversi.
export async function createStopForTransfer(
  admin: SupabaseClient,
  input: CreateStopForTransferInput,
  geocodeCity: GeocodeCityFn
): Promise<CreateStopForTransferResult> {
  const cityName = input.stopName.trim().toUpperCase();
  if (!cityName) return { ok: false, message: "Nome fermata obbligatorio." };

  // Controllo rapido nome esatto: evita geocoding/shift quando la fermata
  // esiste già (percorso comune — la maggior parte dei trasferimenti va su
  // una linea che ha già quella città).
  const existing = await admin
    .from("tenant_bus_line_stops")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("bus_line_id", input.busLineId)
    .eq("direction", input.direction)
    .ilike("stop_name", cityName)
    .maybeSingle();
  if (existing.error) return { ok: false, message: existing.error.message };
  if (existing.data) return { ok: true, stopId: (existing.data as { id: string }).id };

  const { data: lineStops, error: lineStopsErr } = await admin
    .from("tenant_bus_line_stops")
    .select("id,stop_name,city,lat,lng,stop_order")
    .eq("tenant_id", input.tenantId)
    .eq("bus_line_id", input.busLineId)
    .eq("direction", input.direction)
    .eq("active", true)
    .order("stop_order");
  if (lineStopsErr) return { ok: false, message: lineStopsErr.message };

  type GeoStop = { id: string; stop_name: string; city: string; lat: number | null; lng: number | null; stop_order: number };
  const stops = (lineStops ?? []) as GeoStop[];

  const geo = await geocodeCity(cityName);
  let insertOrder = (stops.length > 0 ? Math.max(...stops.map((s) => s.stop_order)) : 0) + 1;

  if (geo) {
    const withCoords = stops.filter((s) => s.lat != null) as Array<GeoStop & { lat: number; lng: number }>;
    if (withCoords.length > 0) {
      const sorted = [...withCoords].sort((a, b) =>
        input.direction === "arrival" ? b.lat - a.lat : a.lat - b.lat
      );
      let insertAfterIdx = sorted.length;
      for (let i = 0; i < sorted.length; i++) {
        const cmp = input.direction === "arrival" ? geo.lat > sorted[i].lat : geo.lat < sorted[i].lat;
        if (cmp) { insertAfterIdx = i; break; }
      }
      if (insertAfterIdx === 0) {
        insertOrder = Math.max(1, sorted[0].stop_order - 1);
      } else if (insertAfterIdx >= sorted.length) {
        insertOrder = sorted[sorted.length - 1].stop_order + 1;
      } else {
        insertOrder = sorted[insertAfterIdx - 1].stop_order + 1;
        for (const s of stops) {
          if (s.stop_order >= insertOrder) {
            const { error: shiftErr } = await admin
              .from("tenant_bus_line_stops")
              .update({ stop_order: s.stop_order + 1, order_index: s.stop_order + 1 })
              .eq("tenant_id", input.tenantId)
              .eq("id", s.id);
            if (shiftErr) return { ok: false, message: shiftErr.message };
          }
        }
      }
    }
  }

  const createResult = await createBusLineStop(admin, {
    tenantId: input.tenantId,
    busLineId: input.busLineId,
    direction: input.direction,
    stopName: cityName,
    city: cityName,
    stopOrder: insertOrder,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
  });
  if (!createResult.ok) {
    if (createResult.reason === "duplicate") return { ok: true, stopId: createResult.existingStopId };
    return { ok: false, message: createResult.reason === "db_error" || createResult.reason === "invalid" ? createResult.message : "Errore creazione fermata." };
  }
  return { ok: true, stopId: createResult.stop.id };
}
