import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema } from "@/lib/mcp/schemas/common";
import {
  ALL_SERVICE_STATUSES,
  checkStatusTransitionAllowed,
  serviceLacksAssignmentWarningApplicable,
} from "@/lib/server/update-service-status-core";
import { generateUpdateServiceStatusConfirmationToken } from "@/lib/mcp/confirmation";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

// Input minimo (FASE 8): solo serviceId + targetStatus. currentStatus viene
// letto dal DB, mai accettato dal client. targetStatus e' validato contro
// TUTTI gli 11 valori reali di ServiceStatus (rifiuta stringhe inventate,
// es. "attesa" o "foo", con MCP_INVALID_INPUT) — se il valore e' reale ma non
// impostabile tramite questo tool (pending_cancellation/cancelled/needs_review),
// passa lo schema e viene segnalato come BLOCKING_CONFLICT nell'handler, con
// un messaggio piu' utile del generico errore di validazione.
const inputSchema = z
  .object({
    serviceId: uuidSchema,
    targetStatus: z.enum(ALL_SERVICE_STATUSES),
  })
  .strict();

const conflictSchema = z.object({ code: z.string(), message: z.string() });

const outputSchema = z.object({
  service: z.object({
    id: z.string(),
    date: z.string().nullable(),
    time: z.string().nullable(),
    type: z.string().nullable(),
  }),
  currentStatus: z.string(),
  targetStatus: z.string(),
  canUpdate: z.boolean(),
  conflicts: z.array(conflictSchema),
  warnings: z.array(conflictSchema),
  sideEffects: z.array(z.string()),
  confirmationToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

const SERVICE_SELECT = "id, date, time, status, service_type, booking_service_kind";

registerTool({
  name: "its.preview_update_service_status",
  description:
    "Anteprima READ-only di una transizione di stato per un servizio: verifica tenant, stato corrente, validita' della transizione ed eventuali segnalazioni, senza scrivere nulla. Se consentita restituisce un confirmation token da passare a its.update_service_status.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const conflicts: Array<{ code: string; message: string }> = [];
      const warnings: Array<{ code: string; message: string }> = [];

      const { data: serviceRow, error: serviceError } = await context.admin
        .from("services")
        .select(SERVICE_SELECT)
        .eq("id", input.serviceId)
        .eq("tenant_id", context.tenantId)
        .maybeSingle();
      if (serviceError) throw serviceError;
      if (!serviceRow) throw new McpError("MCP_NOT_FOUND", "Servizio non trovato.");

      const currentStatus = serviceRow.status as string;
      const targetStatus = input.targetStatus;
      const isNoOp = currentStatus === targetStatus;

      const transitionCheck = checkStatusTransitionAllowed(currentStatus, targetStatus);
      if (!transitionCheck.allowed) {
        conflicts.push({ code: transitionCheck.code, message: transitionCheck.message });
      } else if (isNoOp) {
        // FASE 11: stato gia' uguale — non un conflitto (canUpdate resta
        // true, un token viene comunque emesso: its.update_service_status
        // esegue una scrittura idempotente, stesso pattern gia' stabilito da
        // its.assign_driver per l'idempotenza "no_op").
        warnings.push({ code: "STATUS_ALREADY_SET", message: "Il servizio è già in questo stato: nessuna modifica verrà applicata." });
      }

      // Warning informativo (non bloccante — nessuna route trovata
      // nell'audit impedisce questa transizione se non assegnato): assenza
      // di un'assegnazione autista per una transizione di percorso
      // operativo (partito/arrivato/caricato/scaricato/completato).
      if (!isNoOp && transitionCheck.allowed && serviceLacksAssignmentWarningApplicable(targetStatus)) {
        const { data: assignmentRow } = await context.admin
          .from("assignments")
          .select("id")
          .eq("service_id", input.serviceId)
          .eq("tenant_id", context.tenantId)
          .maybeSingle();
        if (!assignmentRow) {
          warnings.push({ code: "NO_DRIVER_ASSIGNED", message: "Il servizio non ha un'assegnazione autista al momento di questa transizione." });
        }
      }

      const canUpdate = conflicts.length === 0;

      let confirmationToken: string | null = null;
      let expiresAt: string | null = null;
      if (canUpdate) {
        const generated = generateUpdateServiceStatusConfirmationToken({
          userId: context.userId,
          tenantId: context.tenantId,
          serviceId: input.serviceId,
          currentStatus,
          targetStatus,
        });
        confirmationToken = generated.token;
        expiresAt = generated.expiresAt;
      }

      const sideEffects: string[] = [];
      if (canUpdate && !isNoOp) {
        sideEffects.push("Verrà registrato un evento in status_events.");
      }

      return {
        service: {
          id: serviceRow.id as string,
          date: (serviceRow.date as string) ?? null,
          time: (serviceRow.time as string) ?? null,
          type: (serviceRow.service_type as string) ?? (serviceRow.booking_service_kind as string) ?? null,
        },
        currentStatus,
        targetStatus,
        canUpdate,
        conflicts,
        warnings,
        sideEffects,
        confirmationToken,
        expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
