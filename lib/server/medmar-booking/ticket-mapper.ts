/**
 * Determina la tariffa/importo atteso per un gruppo di service_ids,
 * riusando la memoria ticket già esistente (tabella medmar_ticket_memory,
 * migrazione 0158) invece di inventare un catalogo tariffe Medmar.
 *
 * Nessun id_biglietto/id_tariffa numerico Medmar è persistito in
 * medmar_ticket_memory: quando disponibile solo tramite tariff_label/price
 * il campo id_biglietto/id_tariffa resta null e la tariffa è marcata
 * source: "unknown" con un warning esplicito (nessuna emissione possibile
 * con dati incerti).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MedmarPreflightTariff, MedmarPreflightWarning } from "./types";

type TicketMemoryRow = {
  id: string;
  matched_service_id: string | null;
  tariff_label: string | null;
  price_cents: number | null;
  quantity: number | null;
};

export async function mapTariffFromTicketMemory(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[]
): Promise<{ tariff: MedmarPreflightTariff; expectedTotalCents: number | null; warnings: MedmarPreflightWarning[] }> {
  const warnings: MedmarPreflightWarning[] = [];

  const { data, error } = await admin
    .from("medmar_ticket_memory")
    .select("id, matched_service_id, tariff_label, price_cents, quantity")
    .eq("tenant_id", tenantId)
    .in("matched_service_id", serviceIds);

  if (error) {
    warnings.push({ code: "ticket_memory_lookup_failed", message: "Impossibile leggere la memoria ticket per determinare la tariffa." });
    return {
      tariff: { id_biglietto: null, id_tariffa: null, label: null, unit_price_cents: null, source: "unknown" },
      expectedTotalCents: null,
      warnings,
    };
  }

  const rows = (data ?? []) as TicketMemoryRow[];
  if (rows.length === 0) {
    warnings.push({
      code: "tariff_not_found",
      message: "Nessun ticket in memoria abbinato a questo gruppo: tariffa non determinabile automaticamente. Verifica manuale richiesta.",
    });
    return {
      tariff: { id_biglietto: null, id_tariffa: null, label: null, unit_price_cents: null, source: "unknown" },
      expectedTotalCents: null,
      warnings,
    };
  }

  const label = rows.find((r) => r.tariff_label)?.tariff_label ?? null;
  const unitPriceCents = rows.find((r) => r.price_cents != null)?.price_cents ?? null;
  const totalCents = rows.reduce((sum, r) => sum + (r.price_cents ?? 0) * (r.quantity ?? 1), 0);

  return {
    tariff: { id_biglietto: null, id_tariffa: null, label, unit_price_cents: unitPriceCents, source: "ticket_memory" },
    expectedTotalCents: rows.some((r) => r.price_cents != null) ? totalCents : null,
    warnings,
  };
}
