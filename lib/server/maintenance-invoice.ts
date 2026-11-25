/**
 * Fattura allegata a una manutenzione. Bucket privato "vehicle-documents",
 * cartella per tenant e intervento: <tenant_id>/maintenance/<maintenance_id>/
 * Il vincolo vehicle_maintenance_invoice_document_check (migrazione 0303)
 * impone lo stesso prefisso anche nel database.
 */
export const MAINTENANCE_INVOICE_BUCKET = "vehicle-documents";
export const MAINTENANCE_INVOICE_MAX_BYTES = 10 * 1024 * 1024;

// Gli stessi formati accettati dal bucket (migrazione 0160).
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export function isAllowedInvoiceType(contentType: string): boolean {
  return ALLOWED_TYPES.has(contentType.toLowerCase());
}

export function maintenanceInvoiceFolder(tenantId: string, maintenanceId: string): string {
  return `${tenantId}/maintenance/${maintenanceId}`;
}

/** Nome file ripulito (niente "/" o caratteri strani) con timestamp davanti. */
export function maintenanceInvoicePath(tenantId: string, maintenanceId: string, fileName: string, now = Date.now()): string {
  const safe = fileName.normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/_+/g, "_").slice(-120) || "fattura";
  return `${maintenanceInvoiceFolder(tenantId, maintenanceId)}/${now}_${safe}`;
}
