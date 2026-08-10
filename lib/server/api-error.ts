/**
 * Helper condiviso per sanitizzare errori interni prima di restituirli al
 * client. Il messaggio raw (Postgres/Supabase/eccezione qualsiasi) non deve
 * mai comparire nel body della risposta: viene loggato solo server-side via
 * `auditLog`, se `options.event` è presente.
 *
 * Non introduce nulla di nuovo rispetto al pattern già in uso nelle route
 * SEC-06 (catch → auditLog(details.message) → NextResponse.json(fallback)):
 * questo helper si limita a estrarne la parte ripetuta.
 */
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/server/ops-audit";

export type SanitizedErrorField = "error" | "message";

export interface SanitizedErrorOptions {
  /** Status HTTP della risposta sanitizzata. */
  status: number;
  /** Messaggio generico restituito al client al posto del raw error. */
  fallback: string;
  /** Nome del campo body: { error: fallback } oppure { message: fallback }. Default "error". */
  field?: SanitizedErrorField;
  /** Nome evento auditLog. Se omesso, nessun logging viene eseguito. */
  event?: string;
  tenantId?: string | null;
  serviceId?: string | null;
  /** Dettagli aggiuntivi server-side (mai inviati al client). */
  details?: Record<string, unknown>;
}

/**
 * Estrae una stringa diagnostica sicura da un errore di forma qualsiasi,
 * senza mai serializzare l'oggetto raw (evita di propagare accidentalmente
 * details/hint/code Postgres in un JSON.stringify implicito).
 */
function normalizeRawError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/** Invoca auditLog senza mai propagare un throw o una rejection non gestita. */
function logSafely(event: string, payload: Record<string, unknown>) {
  try {
    const result = auditLog({ event, level: "error", ...payload } as Parameters<typeof auditLog>[0]);
    const maybePromise = result as unknown as { catch?: (fn: (e: unknown) => void) => void } | undefined;
    maybePromise?.catch?.(() => {});
  } catch {
    // Il logging non deve mai impedire la risposta sanitizzata.
  }
}

/**
 * Costruisce una NextResponse con un messaggio generico, loggando (se
 * richiesto) il messaggio raw solo server-side.
 */
export function sanitizedErrorResponse(error: unknown, options: SanitizedErrorOptions): NextResponse {
  const { status, fallback, field = "error", event, tenantId = null, serviceId = null, details } = options;

  if (event) {
    logSafely(event, {
      tenantId,
      serviceId,
      details: { ...details, message: normalizeRawError(error) },
    });
  }

  return NextResponse.json({ [field]: fallback }, { status });
}
