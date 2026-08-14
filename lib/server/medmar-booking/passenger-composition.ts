/**
 * Fase 2B.5 — composizione passeggeri (adulti/bambini/infant) di un gruppo
 * di servizi Medmar, derivata dalla colonna strutturata
 * services.ferry_details (vedi lib/booking-ancillaries.ts,
 * medmar_adult_count/medmar_child_count/medmar_infant_count), MAI da testo
 * libero (notes).
 *
 * Se ferry_details non è mai stato valorizzato (prenotazioni precedenti
 * alla Fase 2B.5: i tre contatori sono tutti assenti/zero), si ricade su
 * adults=pax/children=0/infants=0 — lo stesso comportamento del preflight
 * prima di questa fase, preservato esattamente per non alterare il flusso
 * "solo adulti" già in produzione.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MedmarPreflightPassengerCounts } from "./types";

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function maxOf(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

export type PassengerCompositionRow = {
  pax: number | null;
  ferry_details?: unknown;
};

/**
 * Pura, nessuna chiamata IO. Le righe di uno stesso gruppo (andata/ritorno)
 * portano lo stesso ferry_details (valorizzato una volta sola alla
 * creazione della prenotazione): si usa il massimo per riga invece della
 * somma per evitare di raddoppiare i conteggi tra le due gambe.
 */
export function resolvePassengerComposition(rows: PassengerCompositionRow[]): MedmarPreflightPassengerCounts {
  const parsed = rows.map((row) => {
    const fd = row.ferry_details;
    const obj = fd && typeof fd === "object" && !Array.isArray(fd) ? (fd as Record<string, unknown>) : {};
    return {
      adults: asNonNegativeInt(obj.medmar_adult_count),
      children: asNonNegativeInt(obj.medmar_child_count),
      infants: asNonNegativeInt(obj.medmar_infant_count),
    };
  });

  const adults = maxOf(parsed.map((p) => p.adults));
  const children = maxOf(parsed.map((p) => p.children));
  const infants = maxOf(parsed.map((p) => p.infants));

  if (adults + children + infants === 0) {
    const paxFallback = maxOf(rows.map((r) => r.pax ?? 1));
    return { adults: paxFallback, children: 0, infants: 0, source: "pax_fallback" };
  }

  return { adults, children, infants, source: "medmar_counts" };
}

export type PassengerCompositionLoadResult =
  | { ok: true; composition: MedmarPreflightPassengerCounts }
  | { ok: false; error: string };

/**
 * Lettura DB leggera e READ-ONLY (nessuna chiamata Medmar), tenant-scoped
 * come tutte le query di questo modulo. Usata dall'orchestratore come
 * pre-check ECONOMICO prima di qualunque mutazione (openTurn incluso) —
 * vedi issue-orchestrator.ts: deve poter rispondere "ci sono minori?" senza
 * dover eseguire l'intero preflight live.
 */
export async function loadPassengerComposition(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[]
): Promise<PassengerCompositionLoadResult> {
  const { data, error } = await admin
    .from("services")
    .select("pax, ferry_details")
    .in("id", serviceIds)
    .eq("tenant_id", tenantId);

  if (error) {
    return { ok: false, error: "passenger_composition_lookup_failed" };
  }

  const rows = (data ?? []) as PassengerCompositionRow[];
  return { ok: true, composition: resolvePassengerComposition(rows) };
}
