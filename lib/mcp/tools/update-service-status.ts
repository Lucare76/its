import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { updateServiceStatusCore, type McpSettableStatus } from "@/lib/server/update-service-status-core";
import { claimConfirmationToken, verifyUpdateServiceStatusConfirmationToken } from "@/lib/mcp/confirmation";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

// FASE 15: input minimo, SOLO il confirmation token. serviceId/targetStatus
// non sono ripassati dal client — provengono esclusivamente dal payload
// firmato server-side generato da its.preview_update_service_status.
const inputSchema = z.object({ confirmationToken: z.string().min(1).max(4000) }).strict();

const outputSchema = z.object({
  serviceId: z.string(),
  fromStatus: z.string(),
  toStatus: z.string(),
  status: z.enum(["updated", "no_op"]),
});

type Output = z.infer<typeof outputSchema>;

registerTool({
  name: "its.update_service_status",
  description:
    "Esegue una transizione di stato precedentemente approvata via its.preview_update_service_status. Richiede un confirmation_token valido, non scaduto, non gia' usato, emesso per lo stesso utente/tenant. Rivalida lo stato live prima di scrivere.",
  category: "WRITE",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const verified = verifyUpdateServiceStatusConfirmationToken(input.confirmationToken);
      if (!verified.ok) {
        if (verified.reason === "expired") {
          throw new McpError("MCP_CONFIRMATION_EXPIRED", "Il confirmation token e' scaduto. Richiedi una nuova preview.");
        }
        throw new McpError("MCP_CONFIRMATION_INVALID", "Confirmation token non valido.");
      }
      const { payload } = verified;

      // Binding utente/tenant (stesso principio di its.assign_driver): un
      // token emesso per un altro utente o un altro tenant non e' eseguibile,
      // anche se la firma e' valida. Nessun dettaglio su quale dei due non
      // corrisponde.
      if (payload.userId !== context.userId || payload.tenantId !== context.tenantId) {
        throw new McpError("MCP_CONFIRMATION_INVALID", "Confirmation token non valido per questo utente/tenant.");
      }

      // Single-use: il claim e' sincrono e avviene PRIMA di qualunque query/
      // scrittura. Da qui in poi il token resta consumato anche se la
      // rivalidazione sottostante fallisce.
      if (!claimConfirmationToken(payload.jti)) {
        throw new McpError("MCP_CONFIRMATION_ALREADY_USED", "Questo confirmation token e' gia' stato usato.");
      }

      // FASE 16/19: il core rilegge lo stato live e applica un update
      // condizionale (WHERE ... AND status = expectedCurrentStatus) — se lo
      // stato e' cambiato dalla preview (un altro operatore ha gia'
      // transizionato il servizio), l'update non trova righe da aggiornare e
      // il core restituisce STATUS_STALE, mappato qui su MCP_CONFIRMATION_STALE
      // (FASE 14): il payload del token non e' MAI trattato come
      // autorizzazione cieca contro uno stato ormai vecchio.
      const result = await updateServiceStatusCore(context.admin, {
        tenantId: context.tenantId,
        userId: context.userId,
        serviceId: payload.serviceId,
        targetStatus: payload.targetStatus as McpSettableStatus,
        expectedCurrentStatus: payload.currentStatus,
      });

      if (result.status !== 200) {
        const errorCode = String(result.body.error ?? "STATUS_UPDATE_FAILED");
        const message = String(result.body.message ?? "Aggiornamento stato non riuscito.");
        if (errorCode === "SERVICE_NOT_FOUND") {
          throw new McpError("MCP_NOT_FOUND", message);
        }
        if (errorCode === "STATUS_STALE") {
          throw new McpError("MCP_CONFIRMATION_STALE", message);
        }
        if (errorCode === "SERVICE_STATUS_TERMINAL" || errorCode === "TARGET_STATUS_NOT_SETTABLE") {
          throw new McpError("MCP_STATUS_TRANSITION_INVALID", message);
        }
        throw new McpError("MCP_INTERNAL_ERROR", "Errore interno del server MCP.");
      }

      const isNoOp = Boolean(result.body.no_op);
      const output: Output = {
        serviceId: payload.serviceId,
        fromStatus: payload.currentStatus,
        toStatus: payload.targetStatus,
        status: isNoOp ? "no_op" : "updated",
      };
      return output;
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  // FASE 21: audit summary sanitizzato — mai il confirmation token, mai dati
  // cliente/PII.
  buildAuditSummary: (_input, output) => ({
    service_id: output.serviceId,
    from_status: output.fromStatus,
    to_status: output.toStatus,
    result: output.status === "no_op" ? "no_op" : "updated",
  }),
});
