import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildInvoiceServiceDescription,
  type InvoiceServiceContext,
} from "@/lib/invoice-service-label";
import type { InvoiceLineItem, InvoiceData } from "@/lib/server/invoice-pdf";
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Data non valida.",
  );
export const statementSchema = z
  .object({
    agency_id: z.string().uuid().optional(),
    agency_name: z.string().trim().min(1).max(250),
    period_from: isoDate,
    period_to: isoDate,
    date_basis: z.enum(["arrival", "departure"]).default("arrival"),
    send: z.boolean().default(false),
  })
  .refine((v) => v.period_from <= v.period_to, "Il periodo non è valido.");
export type StatementRow = {
  id: string;
  tenant_id: string;
  agency_id: string;
  agency_name: string;
  invoice_number: string;
  date_basis: string;
  period_from: string;
  period_to: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  invoice_data: InvoiceLineItem[];
  total_cents: number;
  paid_cents: number;
  waived_cents: number;
  services_count: number;
};
export function statementItems(items: InvoiceLineItem[]): InvoiceLineItem[] {
  return items.map((item) => ({
    ...item,
    descrizione_servizio:
      item.descrizione_servizio ||
      (item.penalty_id
        ? "Penale cancellazione"
        : buildInvoiceServiceDescription(
            item as InvoiceLineItem & InvoiceServiceContext,
          )),
  }));
}
export function statementData(
  row: StatementRow,
  email?: string | null,
  reviewUrl?: string,
): InvoiceData {
  return {
    agencyName: row.agency_name,
    agencyEmail: email,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    invoiceId: row.id,
    invoiceNumber: row.invoice_number,
    dateBasis: row.date_basis,
    createdAt: row.created_at,
    items: statementItems(row.invoice_data),
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    waivedCents: row.waived_cents,
    reviewUrl,
  };
}
export function statementError(message: string) {
  if(message.includes('STATEMENT_AGENCY_LINK_REQUIRED')) return 'Alcune pratiche hanno un nome agenzia storico diverso dall’anagrafica. Collega o correggi l’agenzia prima di generare l’estratto.';
  if (message.includes("STATEMENT_ALREADY_INCLUDED:"))
    return "Una o più pratiche sono già presenti in un altro estratto conto. Controlla i documenti esistenti prima di procedere.";
  if (message.includes("STATEMENT_MISSING_PRICE:"))
    return "Una pratica non ha un prezzo valido. Completa il prezzo prima di generare l’estratto.";
  if (message.includes("STATEMENT_NO_SERVICES"))
    return "Nessuna pratica fatturabile nel periodo con il criterio scelto.";
  if (message.includes("STATEMENT_PAYMENT_EXCEEDS_BALANCE"))
    return "L’importo supera il residuo da pagare.";
  if (message.includes("STATEMENT_ALREADY_REVIEWED"))
    return "Questo estratto è già stato revisionato. Aggiorna la pagina.";
  return "Operazione non completata. Verifica che l’aggiornamento contabile del database sia stato applicato e riprova.";
}
export async function createStatement(
  admin: SupabaseClient,
  tenantId: string,
  agencyId: string,
  from: string,
  to: string,
  basis: string,
) {
  const { data, error } = await admin.rpc("create_agency_statement", {
    p_tenant_id: tenantId,
    p_agency_id: agencyId,
    p_from: from,
    p_to: to,
    p_basis: basis,
  });
  if (error) throw new Error(error.message);
  return data as { invoice: StatementRow; reused: boolean };
}
export async function listAll<T>(
  getPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await getPage(offset, offset + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 500) return rows;
  }
}
