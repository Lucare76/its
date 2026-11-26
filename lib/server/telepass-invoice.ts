/**
 * Fattura Telepass di un mezzo. Bucket privato "vehicle-documents", cartella
 * per tenant e fattura: <tenant_id>/telepass/<invoice_id>/
 * Il vincolo vehicle_telepass_invoices_document_check (migrazione 0306)
 * impone lo stesso prefisso anche nel database.
 */
export { MAINTENANCE_INVOICE_BUCKET as TELEPASS_INVOICE_BUCKET, MAINTENANCE_INVOICE_MAX_BYTES as TELEPASS_INVOICE_MAX_BYTES, isAllowedInvoiceType } from "@/lib/server/maintenance-invoice";

export function telepassInvoiceFolder(tenantId: string, invoiceId: string): string {
  return `${tenantId}/telepass/${invoiceId}`;
}

export function telepassInvoicePath(tenantId: string, invoiceId: string, fileName: string, now = Date.now()): string {
  const safe = fileName.normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/_+/g, "_").slice(-120) || "fattura";
  return `${telepassInvoiceFolder(tenantId, invoiceId)}/${now}_${safe}`;
}

/** Il path appartiene alla cartella di questa fattura, senza sottocartelle. */
export function isTelepassInvoicePathOf(path: string, tenantId: string, invoiceId: string): boolean {
  const folder = telepassInvoiceFolder(tenantId, invoiceId);
  return path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes("/") && path.length > folder.length + 1;
}

/** Codice dispositivo normalizzato per il confronto (spazi tolti, maiuscolo). */
export function normalizeTelepassCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}
