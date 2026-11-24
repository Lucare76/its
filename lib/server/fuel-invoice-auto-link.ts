import type { SupabaseClient } from "@supabase/supabase-js";
import { selectExactAutoLinks, type ManualFuelLine } from "@/lib/server/fuel-invoice-reconciliation";

/**
 * Collega in automatico le righe della fattura che corrispondono esattamente
 * a un solo rifornimento (vedi selectExactAutoLinks). Tocca solo righe mai
 * gestite (match_method null): una riga scollegata a mano non viene ricollegata.
 * Idempotente e sicuro in concorrenza: ogni update richiede che la riga sia
 * ancora libera e l'indice unico impedisce di usare due volte un rifornimento.
 */
export async function autoLinkExactMatches(db: SupabaseClient, tenantId: string, importId: string,
  supplier: string, userId: string): Promise<number> {
  const { data: open } = await db.from("fuel_invoice_lines")
    .select("id, fuel_date, station, liters, amount, reference")
    .eq("tenant_id", tenantId).eq("import_id", importId)
    .is("matched_fuel_id", null).is("match_method", null);
  if (!open?.length) return 0;
  const dates = open.map((line) => line.fuel_date as string).sort();
  const { data: manual } = await db.from("vehicle_fuel")
    .select("id, fuel_date, station, liters, cost, invoice_supplier, approval_status")
    .eq("tenant_id", tenantId).eq("invoice_supplier", supplier)
    .gte("fuel_date", dates[0]!).lte("fuel_date", dates.at(-1)!).limit(3000);
  if (!manual?.length) return 0;
  const { data: allLinks } = await db.from("fuel_invoice_lines").select("matched_fuel_id")
    .eq("tenant_id", tenantId).not("matched_fuel_id", "is", null);
  const linked = new Set<string>((allLinks ?? []).map((row) => row.matched_fuel_id as string));
  const links = selectExactAutoLinks(
    open.map((line) => ({ id: line.id as string, date: line.fuel_date as string, station: line.station as string,
      liters: Number(line.liters), amount: Number(line.amount), reference: line.reference as string })),
    manual as Array<ManualFuelLine & { approval_status: string }>, supplier, linked,
  );
  let count = 0;
  for (const link of links) {
    const { data: changed, error } = await db.from("fuel_invoice_lines")
      .update({ matched_fuel_id: link.fuel_id, matched_at: new Date().toISOString(), matched_by: userId, match_method: "auto" })
      .eq("tenant_id", tenantId).eq("id", link.line_id)
      .is("matched_fuel_id", null).is("match_method", null)
      .select("id").maybeSingle();
    // Un conflitto (riga già gestita o rifornimento già usato altrove) si salta: resterà manuale.
    if (!error && changed) count += 1;
  }
  return count;
}
