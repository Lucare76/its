const MEDMAR_PRATICA_TAG_RE = /\[practice:([^\]]+)\]/;

export type MedmarBookingGroupKeyRow = {
  id?: string | null;
  linked_service_id?: string | null;
  inbound_email_id?: string | null;
  import_id?: string | null;
  source_quote_id?: string | null;
  notes?: string | null;
  customer_name?: string | null;
};

export function extractMedmarPractice(notes: string | null | undefined): string {
  const match = (notes ?? "").match(MEDMAR_PRATICA_TAG_RE);
  return match?.[1] ?? "";
}

export function medmarBookingGroupKey(row: MedmarBookingGroupKeyRow): string {
  const pratica = extractMedmarPractice(row.notes);
  if (pratica) return `practice:${pratica}`;

  if (row.id && row.linked_service_id) {
    return `linked:${[row.id, row.linked_service_id].sort().join(":")}`;
  }

  if (row.source_quote_id) return `quote:${row.source_quote_id}`;
  if (row.import_id) return `import:${row.import_id}`;
  if (row.inbound_email_id) return `email:${row.inbound_email_id}`;
  if (row.id) return `service:${row.id}`;

  return `name:${(row.customer_name ?? "sconosciuto").trim().toLowerCase().replace(/\s+/g, " ")}`;
}
