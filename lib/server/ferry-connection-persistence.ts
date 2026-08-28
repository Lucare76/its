/**
 * Persistenza di ferry_details.connection — struttura proposta (finora solo
 * annunciata nei commenti di lib/travel-connection-resolver.ts, mai
 * implementata) per salvare, dentro il campo esistente `services.ferry_details`
 * (jsonb, vedi migration 0019), lo stato del collegamento nave/aliscafo per i
 * transfer treno/volo risolti da resolveOperationalConnection.
 *
 * Nessuna nuova colonna DB: riusa ferry_details (già jsonb, già presente su
 * ogni riga services) aggiungendo una chiave 'connection'. Il resto di
 * ferry_details (pet_count, medmar_adult_count, ecc.) resta invariato.
 *
 * Modello (sezione 15 del task Mario):
 *   - `applied`  = collegamento realmente in vigore (quello che l'operatore
 *                  vede in stampa/driver — MA questo file non tocca la
 *                  stampa, solo la persistenza) — auto o manuale.
 *   - `proposal` = ultima proposta calcolata dal resolver, salvata per
 *                  confronto esplicito quando applied.manually_overridden
 *                  è true (il ricalcolo non sovrascrive mai un override
 *                  senza conferma esplicita dell'operatore).
 *   - Il ricalcolo automatico aggiorna SEMPRE `proposal`; aggiorna `applied`
 *     SOLO se `applied` non è un override manuale confermato.
 */
import type { ConnectionRecord, ConnectionConfidence } from "@/lib/travel-connection-resolver";
import { recalculateConnection, connectionFromAutoResult } from "@/lib/travel-connection-resolver";
import type { ResolveTravelConnectionResult } from "@/lib/travel-connection-resolver";
import type { OperationalConnectionResult } from "@/lib/operational-connection-resolver";
import { operationalResultToConnectionRecord } from "@/lib/operational-connection-resolver";

export type FerryConnectionSource = "canonical_rule" | "legacy_fallback" | "manual_override";

export type FerryDetailsConnection = {
  /** Collegamento realmente in vigore (auto o manuale). */
  applied: ConnectionRecord | null;
  /** Ultima proposta calcolata dal resolver — sempre presente dopo il primo calcolo, anche se diversa da `applied`. */
  proposal: ConnectionRecord | null;
  /** Pickup risolto associato al collegamento applicato (da regola canonica, fallback, o inserito manualmente con l'override). */
  pickup_time: string | null;
  source: FerryConnectionSource;
  confidence: ConnectionConfidence;
  warnings: string[];
  /** ISO timestamp dell'ultimo calcolo/conferma. */
  resolved_at: string;
  /** Chi ha confermato l'ultimo `applied`: 'system' per un calcolo automatico, altrimenti l'utente che ha confermato l'override o il ricalcolo. */
  resolved_by: "system" | { user_id: string; email: string | null };
};

/** Legge ferry_details.connection in modo tipizzato — null se assente/malformato (mai un default inventato). */
export function readFerryConnection(ferryDetails: Record<string, unknown> | null | undefined): FerryDetailsConnection | null {
  const raw = (ferryDetails as { connection?: unknown } | null | undefined)?.connection;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<FerryDetailsConnection>;
  if (!("applied" in c) || !("proposal" in c) || !("source" in c)) return null; // shape non riconosciuta
  return c as FerryDetailsConnection;
}

/** Scrive/aggiorna ferry_details.connection preservando le altre chiavi già presenti (pet_count, medmar_*_count, ecc.). */
export function writeFerryConnection(
  ferryDetails: Record<string, unknown> | null | undefined,
  connection: FerryDetailsConnection
): Record<string, unknown> {
  return { ...(ferryDetails ?? {}), connection };
}

/**
 * Costruisce il FerryDetailsConnection iniziale da un OperationalConnectionResult
 * (Livello 1, con context — regola canonica o fallback legacy), SENZA alcun
 * override manuale pregresso.
 */
export function connectionFromOperationalResult(
  result: OperationalConnectionResult,
  resolvedBy: FerryDetailsConnection["resolved_by"] = "system"
): FerryDetailsConnection {
  const record = operationalResultToConnectionRecord(result);
  return {
    applied: record,
    proposal: record,
    pickup_time: result.pickupTime,
    source: result.source,
    confidence: result.confidence,
    warnings: result.warnings,
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
  };
}

/**
 * Applica un ricalcolo (nuovo OperationalConnectionResult) allo stato
 * persistito esistente, rispettando un eventuale override manuale: se
 * `current.applied?.manually_overridden` è true, `applied` NON cambia — solo
 * `proposal` viene aggiornata, per mostrare il confronto in UI. Nessuna
 * scrittura qui: funzione pura, il chiamante decide se persistere il
 * risultato.
 */
export function recalculateFerryConnection(
  current: FerryDetailsConnection | null,
  fresh: OperationalConnectionResult
): FerryDetailsConnection {
  const freshRecord = operationalResultToConnectionRecord(fresh);
  const overridden = current?.applied?.manually_overridden === true;
  return {
    applied: overridden ? current!.applied : freshRecord,
    proposal: freshRecord,
    pickup_time: overridden ? current!.pickup_time : fresh.pickupTime,
    source: overridden ? "manual_override" : fresh.source,
    confidence: overridden ? "ALTA" : fresh.confidence,
    warnings: overridden
      ? [`Override manuale confermato: il ricalcolo automatico non lo sovrascrive. Nuova proposta disponibile per confronto esplicito.`]
      : fresh.warnings,
    resolved_at: overridden ? (current?.resolved_at ?? new Date().toISOString()) : new Date().toISOString(),
    resolved_by: overridden ? (current?.resolved_by ?? "system") : "system",
  };
}

/**
 * Applica un override manuale esplicito confermato dall'operatore (Mario):
 * `applied` diventa il record scelto manualmente, `manually_overridden: true`
 * — la proposta calcolata resta salvata in `proposal` per riferimento, ma non
 * viene più applicata automaticamente finché l'override non viene rimosso.
 */
export function applyManualOverride(
  current: FerryDetailsConnection | null,
  override: ConnectionRecord,
  pickupTime: string | null,
  confirmedBy: { user_id: string; email: string | null }
): FerryDetailsConnection {
  return {
    applied: { ...override, manually_overridden: true, source: "manual" },
    proposal: current?.proposal ?? null,
    pickup_time: pickupTime,
    source: "manual_override",
    confidence: "ALTA",
    warnings: [],
    resolved_at: new Date().toISOString(),
    resolved_by: confirmedBy,
  };
}

/**
 * Rimuove l'override manuale e torna alla proposta calcolata più recente
 * (`current.proposal`), se presente. Richiede conferma esplicita lato UI
 * prima di essere invocata (mai automatico).
 */
export function clearManualOverride(current: FerryDetailsConnection, confirmedBy: { user_id: string; email: string | null }): FerryDetailsConnection {
  const proposal = current.proposal ? { ...current.proposal, manually_overridden: false, source: "auto" as const } : null;
  return {
    applied: proposal,
    proposal: current.proposal,
    pickup_time: current.pickup_time,
    source: proposal ? "legacy_fallback" : "manual_override",
    confidence: current.confidence,
    warnings: [`Override manuale rimosso da ${confirmedBy.email ?? confirmedBy.user_id}: torna alla proposta calcolata.`],
    resolved_at: new Date().toISOString(),
    resolved_by: confirmedBy,
  };
}

// Re-export di comodo per i call-site (API route, UI panel).
export type { ConnectionRecord, ResolveTravelConnectionResult };
export { recalculateConnection, connectionFromAutoResult };
