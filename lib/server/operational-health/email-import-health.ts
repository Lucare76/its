/**
 * Operational Health — Email / import (Sprint 3, area "email").
 *
 * Read-only sopra inbound_emails + services (import PDF, vedi
 * lib/server/pdf-imports.ts — stessa funzione derivePdfImportStatus gia'
 * usata da app/api/email/pdf-imports/route.ts per l'UI di revisione,
 * riusata qui senza reimplementare la classificazione stato).
 *
 * NON sono mai anomalie (per esplicito requisito sprint): email senza PDF,
 * mailbox vuota, nessuna nuova email, duplicate gestite (stato
 * "duplicate"), email volutamente ignorate (stato "ignored"), draft/preview
 * appena arrivati (nessuna SLA nota per "quanto e' vecchio" un draft prima
 * di essere un problema — restano sempre "info", mai "warning").
 *
 * Uniche anomalie riconosciute: parsing/import REALMENTE fallito (stato
 * "failed", derivato da parsed_json.pdf_import.import_state === "failed",
 * scritto dal parser stesso — vedi lib/server/agency-pdf-import.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { derivePdfImportStatus, type InboundRow, type ServiceRow } from "@/lib/server/pdf-imports";
import type { OperationalHealthAreaResult, OperationalHealthSignal, OperationalHealthSignalAction } from "./types";

/**
 * Unica destinazione affidabile per i segnali email/import (Sprint 4):
 * /pdf-imports e' la coda di revisione import PDF — vedi audit sprint.
 * /inbox e' un'area diversa (review agenzia/booking, non pertinente). Nessun
 * query param: la pagina non ne legge nessuno oggi, si linka alla pagina
 * generale.
 */
const EMAIL_IMPORT_OPEN_ACTION: OperationalHealthSignalAction = { label: "Apri import PDF", href: "/pdf-imports" };

/** Finestra e limite di lettura — vedi readEmailImportOperationalHealth. */
export const EMAIL_IMPORT_HEALTH_WINDOW_DAYS = 14;
export const EMAIL_IMPORT_HEALTH_QUERY_LIMIT = 300;

/** Oltre questo numero di "failed" individuali, il resto resta solo nel conteggio aggregato (mai una pagina piena di righe). */
const MAX_FAILED_SIGNALS = 10;

export type EmailImportHealthRow = {
  id: string;
  created_at: string;
  parsed_json: Record<string, unknown>;
  linked_service: { id: string; is_draft: boolean } | null;
};

/**
 * Pura — classifica righe gia' caricate (nessun accesso DB qui). Nessun
 * dato personale nei segnali prodotti: solo id inbound_email (non l'oggetto
 * email, non il mittente).
 */
export function evaluateEmailImportRows(rows: readonly EmailImportHealthRow[], now: Date): OperationalHealthSignal[] {
  const detectedAt = now.toISOString();
  const signals: OperationalHealthSignal[] = [];

  let failedCount = 0;
  let reviewPendingCount = 0;

  for (const row of rows) {
    // Nessun pdf_import associato (email senza PDF / non un import) -> mai un'anomalia, a prescindere
    // da come derivePdfImportStatus classificherebbe un parsed_json vuoto (di default "preview").
    if (row.parsed_json?.pdf_import == null) continue;

    const inboundRow = { id: row.id, tenant_id: "", from_email: null, subject: null, extracted_text: null, parsed_json: row.parsed_json, created_at: row.created_at } as InboundRow;
    const linkedService = row.linked_service
      ? ({ id: row.linked_service.id, inbound_email_id: row.id, is_draft: row.linked_service.is_draft, status: "", customer_name: "", date: "", time: "", notes: "", created_at: row.created_at } as ServiceRow)
      : null;
    const status = derivePdfImportStatus(inboundRow.parsed_json, linkedService);

    if (status === "failed") {
      failedCount += 1;
      if (failedCount <= MAX_FAILED_SIGNALS) {
        signals.push({
          key: `email:import_failed:${row.id}`,
          area: "email",
          severity: "warning",
          title: "Import PDF fallito",
          message: "Un documento PDF ricevuto via email non e' stato importato correttamente (parsing fallito).",
          detectedAt,
          entityId: row.id,
          action: EMAIL_IMPORT_OPEN_ACTION,
        });
      }
      continue;
    }

    if (status === "preview" || status === "draft") {
      reviewPendingCount += 1;
    }
  }

  if (failedCount > MAX_FAILED_SIGNALS) {
    signals.push({
      key: "email:import_failed_more",
      area: "email",
      severity: "warning",
      title: "Altri import PDF falliti",
      message: `Altri ${failedCount - MAX_FAILED_SIGNALS} documenti PDF con parsing fallito (oltre ai ${MAX_FAILED_SIGNALS} gia' elencati).`,
      detectedAt,
      metadata: { additional_failed_count: failedCount - MAX_FAILED_SIGNALS },
      action: EMAIL_IMPORT_OPEN_ACTION,
    });
  }

  if (reviewPendingCount > 0) {
    // Nessuna base temporale affidabile per considerarlo un problema: resta sempre "info", mai "warning" (nessuna SLA inventata).
    signals.push({
      key: "email:review_pending",
      area: "email",
      severity: "info",
      title: "Documenti PDF in attesa di revisione",
      message: `${reviewPendingCount} document${reviewPendingCount === 1 ? "o" : "i"} PDF in attesa di revisione manuale.`,
      detectedAt,
      metadata: { review_pending_count: reviewPendingCount },
      action: EMAIL_IMPORT_OPEN_ACTION,
    });
  }

  return signals;
}

/**
 * I/O — legge solo le email con un import PDF associato (parsed_json.pdf_import
 * presente), nella finestra recente, limitate — mai l'intera inbox storica.
 * Nessun campo email/mittente selezionato oltre l'id (privacy).
 */
export async function readEmailImportOperationalHealth(
  admin: SupabaseClient,
  tenantId: string,
  now: Date
): Promise<OperationalHealthAreaResult> {
  const windowStartIso = new Date(now.getTime() - EMAIL_IMPORT_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: inboundRows, error: inboundError } = await admin
    .from("inbound_emails")
    .select("id, created_at, parsed_json")
    .eq("tenant_id", tenantId)
    .gte("created_at", windowStartIso)
    .not("parsed_json->pdf_import", "is", null)
    .order("created_at", { ascending: false })
    .limit(EMAIL_IMPORT_HEALTH_QUERY_LIMIT);

  if (inboundError) {
    return { area: "email", available: false, error: "Salute import email non disponibile.", signals: [] };
  }

  const rows = (inboundRows ?? []) as Array<{ id: string; created_at: string; parsed_json: Record<string, unknown> }>;
  const inboundIds = rows.map((r) => r.id);

  const { data: serviceRows, error: serviceError } = inboundIds.length
    ? await admin.from("services").select("id, inbound_email_id, is_draft").eq("tenant_id", tenantId).in("inbound_email_id", inboundIds)
    : { data: [] as Array<{ id: string; inbound_email_id: string; is_draft: boolean }>, error: null };

  if (serviceError) {
    return { area: "email", available: false, error: "Salute import email non disponibile.", signals: [] };
  }

  const serviceByInboundId = new Map((serviceRows ?? []).map((s) => [String((s as { inbound_email_id: string }).inbound_email_id), s as { id: string; is_draft: boolean }]));

  const healthRows: EmailImportHealthRow[] = rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    parsed_json: row.parsed_json,
    linked_service: serviceByInboundId.get(row.id) ?? null,
  }));

  return { area: "email", available: true, signals: evaluateEmailImportRows(healthRows, now) };
}
