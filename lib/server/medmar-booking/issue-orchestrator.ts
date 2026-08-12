import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { runMedmarPreflight } from "./preflight";
import { fetchBigliettiVendibiliReadOnly } from "./client";
import { getMedmarIssueConfig, validateMedmarIssueConfig } from "./issue-config";
import { createIssueRepository } from "./issue-repository";
import { createMedmarMutationClient, MedmarMutationDefinitiveError, MedmarMutationRemoteUnknownError } from "./medmar-mutation-client";
import { buildBookingPayload, buildLockTickets, MedmarIssuePayloadError, validateAdultFrozenTickets } from "./issue-payload";
import { resolveMedmarIssueSessionContext } from "./issue-session-context";
import type {
  IssueOrchestratorInput,
  IssueRepository,
  MedmarIssueAttempt,
  MedmarIssueResult,
  MedmarIssueSessionContext,
  MedmarIssueStatus,
  MedmarMutationClient,
  RunPreflightFn,
} from "./issue-types";

const IN_PROGRESS: ReadonlySet<MedmarIssueStatus> = new Set([
  "preflight_started",
  "preflight_ok",
  "lock_started",
  "locked",
  "booking_started",
  "booked",
  "payment_started",
  "paid",
  "unlock_started",
]);

function buildIdempotencyKey(serviceIds: string[]): string {
  return `medmar_passenger_ar:${[...serviceIds].sort().join(",")}`;
}

function centsFromEuros(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Math.round(parsed * 100);
}

function eurosFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.name;
  return "unknown_error";
}

async function transition(input: {
  repo: IssueRepository;
  attempt: MedmarIssueAttempt;
  tenantId: string;
  userId: string;
  next: MedmarIssueStatus;
  eventType: string;
  patch?: Partial<MedmarIssueAttempt>;
  errorCode?: string | null;
}) {
  const previous = input.attempt.status;
  const updated = await input.repo.updateAttempt(input.attempt.id, {
    ...input.patch,
    status: input.next,
    last_error_code: input.errorCode ?? input.patch?.last_error_code ?? null,
  });
  await input.repo.addEvent({
    tenantId: input.tenantId,
    attemptId: input.attempt.id,
    previousStatus: previous,
    newStatus: input.next,
    eventType: input.eventType,
    errorCode: input.errorCode ?? null,
    createdBy: input.userId,
  });
  auditLog({
    event: "medmar_issue_transition",
    level: input.next === "completed" ? "info" : input.next.includes("failed") || input.next === "remote_state_unknown" ? "warn" : "info",
    tenantId: input.tenantId,
    userId: input.userId,
    outcome: input.next,
    details: { previous_status: previous, attempt_id: input.attempt.id, error_code: input.errorCode ?? undefined },
  });
  return updated;
}

function existingAttemptResult(attempt: MedmarIssueAttempt, idempotencyKey: string): MedmarIssueResult | null {
  if (attempt.status === "completed" && attempt.medmar_id_prenotazione && attempt.medmar_numero && attempt.final_total_cents != null) {
    return {
      ok: true,
      status: "completed",
      idempotency_key: idempotencyKey,
      attempt_id: attempt.id,
      medmar_id_prenotazione: attempt.medmar_id_prenotazione,
      medmar_numero: attempt.medmar_numero,
      final_total_cents: attempt.final_total_cents,
      existing: true,
    };
  }
  if (attempt.status === "remote_state_unknown" || attempt.remote_state_unknown) {
    return { ok: false, status: "remote_state_unknown", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Stato Medmar da verificare manualmente. Non riprovare l'emissione.", retry_allowed: false };
  }
  if (IN_PROGRESS.has(attempt.status)) {
    return { ok: false, status: "already_in_progress", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Emissione Medmar gia in corso.", retry_allowed: false };
  }
  return null;
}

export function createMedmarIssueOrchestrator(deps?: {
  repo?: IssueRepository;
  mutationClient?: MedmarMutationClient;
  runPreflight?: RunPreflightFn;
  fetchVendibili?: typeof fetchBigliettiVendibiliReadOnly;
  config?: ReturnType<typeof getMedmarIssueConfig>;
  resolveSessionContext?: (input: { mutationClient: MedmarMutationClient }) => Promise<
    | { ok: true; context: MedmarIssueSessionContext }
    | { ok: false; status: "not_ready" | "remote_state_unknown"; error: string; retry_allowed: boolean }
  >;
}) {
  return async function issueMedmar(input: IssueOrchestratorInput & { admin: SupabaseClient }): Promise<MedmarIssueResult> {
    const config = deps?.config ?? getMedmarIssueConfig();
    const configBlocker = validateMedmarIssueConfig(config);
    if (configBlocker === "feature_disabled") {
      return { ok: false, status: "feature_disabled", error: "Emissione Medmar disabilitata.", retry_allowed: false };
    }
    if (configBlocker) return { ok: false, status: "not_ready", error: "Configurazione emissione Medmar incompleta.", retry_allowed: false };

    const idempotencyKey = buildIdempotencyKey(input.serviceIds);
    const repo = deps?.repo ?? createIssueRepository(input.admin);
    const existingAttempt = await repo.findAttempt(input.tenantId, idempotencyKey);
    if (existingAttempt) {
      const existing = existingAttemptResult(existingAttempt, idempotencyKey);
      if (existing) return existing;
    }

    const mutationClient = deps?.mutationClient ?? createMedmarMutationClient();
    const sessionContextResult = await (deps?.resolveSessionContext ?? resolveMedmarIssueSessionContext)({ mutationClient });
    if (!sessionContextResult.ok) {
      return {
        ok: false,
        status: sessionContextResult.status,
        idempotency_key: idempotencyKey,
        error: sessionContextResult.error,
        retry_allowed: sessionContextResult.retry_allowed,
      };
    }
    const sessionContext = sessionContextResult.context;

    const acquired = await repo.acquireAttempt({
      tenantId: input.tenantId,
      idempotencyKey,
      serviceIds: [...input.serviceIds].sort(),
      createdBy: input.userId,
    });
    let attempt = acquired.attempt;
    if (acquired.kind === "existing") {
      const existing = existingAttemptResult(attempt, idempotencyKey);
      if (existing) return existing;
    }

    const runPreflightFn = deps?.runPreflight ?? ((tenantId, serviceIds) => runMedmarPreflight(input.admin, tenantId, serviceIds));
    const preflight = await runPreflightFn(input.tenantId, input.serviceIds);
    if (preflight.status !== "ok" || !preflight.can_issue || !preflight.is_live) {
      await transition({
        repo,
        attempt,
        tenantId: input.tenantId,
        userId: input.userId,
        next: "preflight_failed",
        eventType: "preflight_failed",
        patch: { preflight_snapshot: preflight, last_error_message: preflight.status },
        errorCode: preflight.status,
      });
      return { ok: false, status: "preflight_failed", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Preflight Medmar non valido.", retry_allowed: true };
    }

    attempt = await transition({
      repo,
      attempt,
      tenantId: input.tenantId,
      userId: input.userId,
      next: "preflight_ok",
      eventType: "preflight_ok",
      patch: { preflight_snapshot: preflight, expected_total_cents: preflight.expected_total_cents },
    });

    const services = await repo.loadServices(input.tenantId, input.serviceIds);
    if (services.length !== input.serviceIds.length) {
      await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "manual_review", eventType: "services_missing", errorCode: "services_missing" });
      return { ok: false, status: "manual_review", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Servizi non trovati nel tenant corrente.", retry_allowed: false };
    }

    const fetchVendibili = deps?.fetchVendibili ?? fetchBigliettiVendibiliReadOnly;
    const vendibiliByCorsa = new Map<string, Awaited<ReturnType<typeof fetchBigliettiVendibiliReadOnly>>>();
    for (const leg of [preflight.outward, preflight.return]) {
      if (leg?.id_corsa != null) {
        vendibiliByCorsa.set(String(leg.id_corsa), await fetchVendibili(leg.id_corsa));
      }
    }

    let lockTickets;
    let bookingPayload;
    try {
      lockTickets = buildLockTickets(preflight, vendibiliByCorsa);
    } catch (err) {
      await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "manual_review", eventType: "payload_not_ready", errorCode: sanitizeError(err) });
      return { ok: false, status: "manual_review", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Payload Medmar non costruibile con dati verificati.", retry_allowed: false };
    }

    try {
      attempt = await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "lock_started", eventType: "lock_started" });
      const lock = await mutationClient.lockAvailability({ biglietti: lockTickets, utente: sessionContext.turnoId });
      if (lock.nonDisponibili.length > 0) {
        await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "lock_failed", eventType: "lock_not_available", patch: { lock_snapshot: { nonDisponibili: lock.nonDisponibili.length } }, errorCode: "non_disponibili" });
        return { ok: false, status: "lock_failed", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Medmar segnala biglietti non disponibili.", retry_allowed: true };
      }
      const frozenAdults = validateAdultFrozenTickets(lockTickets, lock.congelati);
      attempt = await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "locked", eventType: "locked", patch: { lock_snapshot: { frozen_adults: frozenAdults } } });

      bookingPayload = buildBookingPayload({ preflight, services, vendibiliByCorsa, frozenAdults, config, sessionContext });
      attempt = await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "booking_started", eventType: "booking_started", patch: { booking_payload_hash: hashPayload(bookingPayload) } });
      const booking = await mutationClient.createBooking(bookingPayload);
      const bookingTotalCents = centsFromEuros(booking.prezzo_totale);
      attempt = await transition({
        repo,
        attempt,
        tenantId: input.tenantId,
        userId: input.userId,
        next: "booked",
        eventType: "booked",
        patch: { medmar_id_prenotazione: String(booking.id_prenotazione), final_total_cents: bookingTotalCents },
      });

      attempt = await transition({ repo, attempt, tenantId: input.tenantId, userId: input.userId, next: "payment_started", eventType: "payment_started" });
      const payment = await mutationClient.payManual({
        id_prenotazione: booking.id_prenotazione,
        prezzo: eurosFromCents(bookingTotalCents),
        id_cliente: sessionContext.clienteId,
        id_modalita: 5,
      });
      if (String(payment.id_prenotazione) !== String(booking.id_prenotazione) || centsFromEuros(payment.prezzo) !== bookingTotalCents) {
        throw new MedmarMutationRemoteUnknownError("Pagamento manuale non coerente con prenotazione.");
      }
      attempt = await transition({
        repo,
        attempt,
        tenantId: input.tenantId,
        userId: input.userId,
        next: "paid",
        eventType: "paid",
        patch: { medmar_numero: payment.numero, final_total_cents: bookingTotalCents },
      });

      attempt = await transition({
        repo,
        attempt,
        tenantId: input.tenantId,
        userId: input.userId,
        next: "completed",
        eventType: "completed",
        patch: { medmar_numero: payment.numero, final_total_cents: bookingTotalCents, completed_at: new Date().toISOString() },
      });
      return {
        ok: true,
        status: "completed",
        idempotency_key: idempotencyKey,
        attempt_id: attempt.id,
        medmar_id_prenotazione: attempt.medmar_id_prenotazione!,
        medmar_numero: payment.numero,
        final_total_cents: bookingTotalCents,
        existing: false,
      };
    } catch (err) {
      const remoteUnknown = err instanceof MedmarMutationRemoteUnknownError;
      const definitive = err instanceof MedmarMutationDefinitiveError || err instanceof MedmarIssuePayloadError;
      const next: MedmarIssueStatus = remoteUnknown
        ? "remote_state_unknown"
        : attempt.status === "payment_started"
          ? "payment_failed_definitive"
          : attempt.status === "booking_started"
            ? "booking_failed_definitive"
            : "lock_failed";
      await transition({
        repo,
        attempt,
        tenantId: input.tenantId,
        userId: input.userId,
        next,
        eventType: next,
        patch: { remote_state_unknown: remoteUnknown, last_error_message: definitive || remoteUnknown ? err.message : "Errore emissione Medmar." },
        errorCode: sanitizeError(err),
      });
      if (remoteUnknown) {
        return { ok: false, status: "remote_state_unknown", idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Stato Medmar da verificare manualmente. Non riprovare l'emissione.", retry_allowed: false };
      }
      return { ok: false, status: next, idempotency_key: idempotencyKey, attempt_id: attempt.id, error: "Emissione Medmar interrotta.", retry_allowed: next === "lock_failed" };
    }
  };
}
