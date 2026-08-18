import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadOperationalVehicles } from "@/lib/server/vehicle-catalog";
import { assignServiceCore } from "@/lib/server/assign-service-core";
import { claimConfirmationToken, verifyAssignDriverConfirmationToken } from "@/lib/mcp/confirmation";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

// Input minimo: SOLO il confirmation token. serviceId/driverId/vehicleId non
// sono ripassati dal client — vengono recuperati esclusivamente dal payload
// firmato server-side generato da its.preview_assign_driver (Fase 17: il
// client non deve poter "inventare" un payload diverso da quello approvato).
const inputSchema = z.object({ confirmationToken: z.string().min(1).max(4000) }).strict();

const outputSchema = z.object({
  serviceId: z.string(),
  driverId: z.string(),
  vehicleId: z.string().nullable(),
  status: z.enum(["assigned", "no_op"]),
  groupId: z.string().nullable(),
});

type Output = z.infer<typeof outputSchema>;

registerTool({
  name: "its.assign_driver",
  description:
    "Esegue un'assegnazione autista(+mezzo) precedentemente approvata via its.preview_assign_driver. Richiede un confirmation_token valido, non scaduto, non gia' usato, emesso per lo stesso utente/tenant. Rivalida tutto lo stato live prima di scrivere.",
  category: "WRITE",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const verified = verifyAssignDriverConfirmationToken(input.confirmationToken);
      if (!verified.ok) {
        if (verified.reason === "expired") {
          throw new McpError("MCP_CONFIRMATION_EXPIRED", "Il confirmation token e' scaduto. Richiedi una nuova preview.");
        }
        throw new McpError("MCP_CONFIRMATION_INVALID", "Confirmation token non valido.");
      }
      const { payload } = verified;

      // Binding utente/tenant: un token emesso per un altro utente o un altro
      // tenant non e' eseguibile, anche se la firma e' valida (es. un admin
      // con membership su piu' tenant che tenta di eseguire con il tenant
      // attivo sbagliato). Nessun dettaglio su quale dei due non corrisponde:
      // stesso errore generico per non rivelare a chi appartiene il token.
      if (payload.userId !== context.userId || payload.tenantId !== context.tenantId) {
        throw new McpError("MCP_CONFIRMATION_INVALID", "Confirmation token non valido per questo utente/tenant.");
      }

      // Single-use + chiusura della race "due execute simultanei": il claim è
      // sincrono e avviene PRIMA di qualunque query/scrittura. Da qui in poi,
      // anche se la rivalidazione sottostante fallisce, il token resta
      // consumato: forza una nuova preview invece di ritentare alla cieca uno
      // stato ormai vecchio.
      if (!claimConfirmationToken(payload.jti)) {
        throw new McpError("MCP_CONFIRMATION_ALREADY_USED", "Questo confirmation token e' gia' stato usato.");
      }

      // Rivalidazione completa: il payload del token NON è mai trattato come
      // autorizzazione cieca. Driver e mezzo vengono ri-risolti ora (non dal
      // token) cosi' un driver/mezzo rimosso o disattivato nel frattempo
      // produce un errore fresco, non uno stantio.
      const drivers = await listDriverRegistry(context.admin, context.tenantId, { activeOnly: false });
      const driver = drivers.find((entry) => entry.id === payload.driverId);
      if (!driver) throw new McpError("MCP_NOT_FOUND", "Autista non trovato.");

      let vehicleLabel: string | null = null;
      if (payload.vehicleId) {
        const vehicles = await loadOperationalVehicles(context.admin, context.tenantId, { activeOnly: false });
        const vehicleRow = vehicles.find((entry) => entry.id === payload.vehicleId);
        if (!vehicleRow) throw new McpError("MCP_NOT_FOUND", "Mezzo non trovato.");
        vehicleLabel = vehicleRow.label;
      }

      // Fase 19 (idempotenza): se l'assegnazione richiesta e' gia' esattamente
      // quella presente, il core sottostante esegue comunque un update
      // idempotente (nessun errore, nessuna nuova assignment history, perche'
      // driverChanged/vehicleChanged risultano entrambi false) — qui rileviamo
      // solo per etichettare onestamente l'esito come "no_op" invece di
      // "assigned", senza cambiare cosa viene scritto.
      const { data: existingAssignmentRow } = await context.admin
        .from("assignments")
        .select("driver_profile_id, vehicle_label")
        .eq("service_id", payload.serviceId)
        .eq("tenant_id", context.tenantId)
        .maybeSingle();
      const isNoOp =
        Boolean(existingAssignmentRow) &&
        (existingAssignmentRow?.driver_profile_id ?? null) === driver.id &&
        ((existingAssignmentRow?.vehicle_label as string | null | undefined) || null) === (vehicleLabel || null);

      // Stesso core condiviso della route HTTP /api/ops/assign-service:
      // stessi guard (overlap driver/mezzo, stato servizio, disponibilita'
      // giorno), stessa scrittura (trip_groups/assignments/status_events),
      // stesso assignment history, stesso race protection (unique 23505).
      const result = await assignServiceCore(context.admin, {
        tenantId: context.tenantId,
        userId: context.userId,
        serviceId: payload.serviceId,
        driverUserId: driver.user_id,
        driverProfileId: driver.id,
        vehicleLabel,
        action: "assign",
        // ML Data Collection Sprint 2 (FASE 8): MCP non ha oggi un
        // recommendation layer con candidati/ranking propri — solo la
        // source viene etichettata, il resto resta null/non passato.
        source: "mcp",
      });

      if (result.status !== 200) {
        const errorCode = String(result.body.error ?? "ASSIGNMENT_FAILED");
        const message = String(result.body.message ?? result.body.error ?? "Assegnazione non riuscita.");
        // SERVICE_ALREADY_ASSIGNED e' il caso letterale di Fase 16: lo stato
        // e' cambiato tra preview ed execute (un altro operatore ha
        // assegnato nel frattempo) — mappato su STALE anziché sul generico
        // CONFLICT per essere precisi sul perche'.
        if (errorCode === "SERVICE_ALREADY_ASSIGNED") {
          throw new McpError("MCP_CONFIRMATION_STALE", message);
        }
        throw new McpError("MCP_ASSIGNMENT_CONFLICT", message);
      }

      const groupId = (result.body.group_id as string | undefined) ?? null;
      const output: Output = {
        serviceId: payload.serviceId,
        driverId: payload.driverId,
        vehicleId: payload.vehicleId,
        status: isNoOp ? "no_op" : "assigned",
        groupId,
      };
      return output;
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  // Fase 20: input_summary sanitizzato — mai il confirmation token, mai dati cliente.
  buildAuditSummary: (_input, output) => ({
    service_id: output.serviceId,
    driver_id: output.driverId,
    vehicle_id: output.vehicleId,
    result: output.status,
  }),
});
