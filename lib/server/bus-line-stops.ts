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
