import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

/** Codice del permesso per-utente (tenant_user_feature_flags) per chiudere le fatture. */
export const FUEL_INVOICE_CLOSE_FLAG = "fuel_invoice_close";

export type SummaryLine = { id: string; line_no: number; liters: number; amount: number; matched_fuel_id: string | null };
export type SummaryFuel = {
  id: string; liters: number | null; cost: number | null; approval_status?: string | null;
  fiscal_document_name?: string | null; fiscal_document_url?: string | null;
};

export type FuelInvoiceSummary = {
  lines_count: number;
  lines_linked: number;
  /** Somma delle righe carburante lette dal PDF (fee e commissioni escluse in lettura). */
  invoice_total: number;
  /** Somma degli importi registrati nei rifornimenti collegati. */
  linked_total: number;
  /** invoice_total - somma delle sole righe collegate: quanto della fattura non ha riscontro. */
  unlinked_amount: number;
  /** Fattura (righe collegate) meno registro: differenza sugli importi collegati. */
  linked_difference: number;
  lines_with_differences: Array<{ line_id: string; line_no: number; amount_difference: number | null; liters_difference: number | null }>;
  unlinked_lines: Array<{ line_id: string; line_no: number }>;
  pending_approval: number;
  /** Rifornimenti con un documento fiscale già inserito diverso da quello di questa fattura. */
  document_conflicts: Array<{ fuel_id: string; fiscal_document_name: string | null }>;
  /** Tutte le righe collegate, ciascuna con litri identici e importo entro 1 centesimo. */
  all_match: boolean;
};

const cents = (value: number) => Math.round(value * 100);
const euros = (centsValue: number) => centsValue / 100;

export function fuelInvoiceDocumentName(supplier: string, invoiceNumber: string) {
  return `Fattura ${supplier} ${invoiceNumber}`.slice(0, 200);
}

/**
 * Riepilogo per decidere se una fattura "torna". Lavora in centesimi per
 * evitare errori di arrotondamento sulle somme. Il netto UTA è registrato a
 * quattro decimali: ogni riga collegata tollera 1 centesimo, come nel
 * collegamento automatico.
 */
export function summarizeFuelInvoice(lines: SummaryLine[], fuels: SummaryFuel[], documentName: string): FuelInvoiceSummary {
  const fuelById = new Map(fuels.map((fuel) => [fuel.id, fuel]));
  let invoiceCents = 0; let linkedInvoiceCents = 0; let linkedRegistryCents = 0;
  const differences: FuelInvoiceSummary["lines_with_differences"] = [];
  const unlinked: FuelInvoiceSummary["unlinked_lines"] = [];
  const conflicts: FuelInvoiceSummary["document_conflicts"] = [];
  let linkedCount = 0; let pending = 0;

  for (const line of lines) {
    invoiceCents += cents(Number(line.amount));
    const fuel = line.matched_fuel_id ? fuelById.get(line.matched_fuel_id) : undefined;
    if (!fuel) { unlinked.push({ line_id: line.id, line_no: line.line_no }); continue; }
    linkedCount += 1;
    linkedInvoiceCents += cents(Number(line.amount));
    if (fuel.cost != null) linkedRegistryCents += cents(Number(fuel.cost));
    if (fuel.approval_status === "pending") pending += 1;
    const amountDiff = fuel.cost == null ? null : cents(Number(line.amount)) - cents(Number(fuel.cost));
    const litersDiff = fuel.liters == null ? null : cents(Number(line.liters)) - cents(Number(fuel.liters));
    if (amountDiff == null || litersDiff == null || Math.abs(amountDiff) > 1 || litersDiff !== 0) {
      differences.push({ line_id: line.id, line_no: line.line_no,
        amount_difference: amountDiff == null ? null : euros(amountDiff),
        liters_difference: litersDiff == null ? null : euros(litersDiff) });
    }
    const existingName = (fuel.fiscal_document_name ?? "").trim();
    const hasDocument = Boolean(existingName || (fuel.fiscal_document_url ?? "").trim());
    if (hasDocument && existingName !== documentName) {
      conflicts.push({ fuel_id: fuel.id, fiscal_document_name: fuel.fiscal_document_name ?? null });
    }
  }

  return {
    lines_count: lines.length,
    lines_linked: linkedCount,
    invoice_total: euros(invoiceCents),
    linked_total: euros(linkedRegistryCents),
    unlinked_amount: euros(invoiceCents - linkedInvoiceCents),
    linked_difference: euros(linkedInvoiceCents - linkedRegistryCents),
    lines_with_differences: differences,
    unlinked_lines: unlinked,
    pending_approval: pending,
    document_conflicts: conflicts,
    all_match: lines.length > 0 && unlinked.length === 0 && differences.length === 0,
  };
}

/** Chiude: admin sempre; operatori solo se abilitati uno per uno dall'admin. */
export async function canCloseFuelInvoices(auth: PricingAuthContext): Promise<boolean> {
  if (auth.membership.role === "admin") return true;
  if (auth.membership.role !== "operator") return false;
  const { data, error } = await (auth.admin as unknown as SupabaseClient).from("tenant_user_feature_flags")
    .select("enabled")
    .eq("tenant_id", auth.membership.tenant_id).eq("user_id", auth.user.id)
    .eq("feature_code", FUEL_INVOICE_CLOSE_FLAG).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.enabled === true;
}
