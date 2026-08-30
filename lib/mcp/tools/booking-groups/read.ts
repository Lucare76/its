/**
 * FASE 3 — Tool MCP READ per il dominio GRUPPI PRENOTAZIONE.
 *
 * §3 audit / §29 toolset:
 *  - its.find_booking_group                         (lookup per nome/data/id, ambiguità NON risolta)
 *  - its.get_booking_group_detail                   (dettaglio + pax progressivi)
 *  - its.preview_booking_group_operationalization   (vista operativizzazione + confirmation token)
 *
 * Pattern riusati:
 *  - registry: registerTool (lib/mcp/registry.ts)
 *  - schema comuni: uuidSchema / isoDateSchema (lib/mcp/schemas/common.ts)
 *  - errori sicuri: McpError / toSafeMcpError (lib/mcp/errors.ts)
 *  - confirmation token: generateBookingGroupConfirmationToken (lib/mcp/confirmation.ts)
 *  - logica di dominio: lib/server/booking-groups-service.ts (STESSA della route HTTP)
 *
 * Nessuna scrittura. `preview_*` emette solo un token opaco che
 * its.operationalize_booking_group ri-valida contro lo stato live.
 */
import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema, isoDateSchema } from "@/lib/mcp/schemas/common";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";
import { generateBookingGroupConfirmationToken } from "@/lib/mcp/confirmation";
import {
  findBookingGroups,
  loadGroupDetail,
  previewOperationalizeBookingGroup,
} from "@/lib/server/booking-groups-service";

const READ_ROLES = ["admin", "operator", "supervisor"] as const;

/** ISO YYYY-MM-DD -> DD/MM/YYYY (§21: la preview mostra sempre la data assoluta). */
export function fmtDateIt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// ─── its.find_booking_group ───────────────────────────────────────────────

const matchSchema = z.object({
  id: z.string(),
  name: z.string(),
  expected_pax: z.number(),
  kind: z.string(),
  status: z.string(),
  service_date: z.string().nullable(),
  service_date_label: z.string().nullable(),
});

registerTool({
  name: "its.find_booking_group",
  description:
    "Cerca gruppi prenotazione per nome (case-insensitive, esatto o parziale), opzionalmente filtrando per data servizio, oppure per id esatto. NON sceglie mai al posto dell'utente: se piu' gruppi sono plausibili restituisce ambiguous=true con l'elenco, e chi chiama deve chiedere disambiguazione prima di qualunque scrittura.",
  category: "READ",
  inputSchema: z
    .object({
      query: z.string().trim().min(1).max(200).optional(),
      serviceDate: isoDateSchema.optional(),
      bookingGroupId: uuidSchema.optional(),
    })
    .strict()
    .refine((v) => Boolean(v.query || v.bookingGroupId), {
      message: "Specificare almeno 'query' o 'bookingGroupId'.",
    }),
  outputSchema: z.object({
    strategy: z.enum(["id", "exact_same_date", "exact", "partial", "recent"]),
    ambiguous: z.boolean(),
    count: z.number(),
    matches: z.array(matchSchema),
  }),
  allowedRoles: READ_ROLES,
  async handler(context, input) {
    try {
      const res = await findBookingGroups(context.admin, context.tenantId, {
        id: input.bookingGroupId ?? null,
        query: input.query ?? null,
        serviceDate: input.serviceDate ?? null,
      });
      return {
        strategy: res.strategy,
        ambiguous: res.ambiguous,
        count: res.matches.length,
        matches: res.matches.map((m) => ({ ...m, service_date_label: fmtDateIt(m.service_date) })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({
    by: input.bookingGroupId ? "id" : "query",
    strategy: output.strategy,
    count: output.count,
    ambiguous: output.ambiguous,
  }),
});

// ─── its.get_booking_group_detail ────────────────────────────────────────

registerTool({
  name: "its.get_booking_group_detail",
  description:
    "Dettaglio di un gruppo prenotazione: dati commerciali, fermate pianificate, riserve bus date-scoped, servizi collegati e quadro pax progressivo (previsti / pianificati sulle fermate / gia' trasformati in servizi / gap). Sola lettura.",
  category: "READ",
  inputSchema: z.object({ bookingGroupId: uuidSchema }).strict(),
  outputSchema: z.object({
    group: z.record(z.string(), z.unknown()),
    stops: z.array(z.record(z.string(), z.unknown())),
    bus_reservations: z.array(z.record(z.string(), z.unknown())),
    services: z.array(
      z.object({
        id: z.string(),
        customer_name: z.string().nullable(),
        pax: z.number(),
        direction: z.string().nullable(),
        date: z.string().nullable(),
        status: z.string().nullable(),
        is_draft: z.boolean().nullable(),
      }),
    ),
    summary: z.record(z.string(), z.unknown()),
    stop_summaries: z.array(z.record(z.string(), z.unknown())),
  }),
  allowedRoles: READ_ROLES,
  async handler(context, input) {
    try {
      const detail = await loadGroupDetail(context.admin, context.tenantId, input.bookingGroupId);
      if (!detail) throw new McpError("MCP_NOT_FOUND", "Gruppo prenotazione non trovato.");
      return {
        group: detail.group as unknown as Record<string, unknown>,
        stops: detail.stops as unknown as Array<Record<string, unknown>>,
        bus_reservations: detail.bus_reservations as unknown as Array<Record<string, unknown>>,
        services: detail.services.map((s) => ({
          id: s.id,
          customer_name: s.customer_name,
          pax: Number(s.pax ?? 0),
          direction: s.direction,
          date: s.date,
          status: s.status,
          is_draft: s.is_draft,
        })),
        summary: detail.summary as unknown as Record<string, unknown>,
        stop_summaries: detail.stop_summaries as unknown as Array<Record<string, unknown>>,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({
    booking_group_id: input.bookingGroupId,
    stops: output.stops.length,
    services: output.services.length,
  }),
});

// ─── its.preview_booking_group_operationalization ────────────────────────

registerTool({
  name: "its.preview_booking_group_operationalization",
  description:
    "Anteprima READ-only dell'operativizzazione di un gruppo: quanti servizi bozza sono pronti, quali bloccati e perche' (missing_fields), warning di gruppo (traghetto / riserva bus). Se almeno un servizio e' pronto restituisce un confirmation token da passare a its.operationalize_booking_group. Non scrive nulla.",
  category: "READ",
  inputSchema: z.object({ bookingGroupId: uuidSchema }).strict(),
  outputSchema: z.object({
    booking_group_id: z.string(),
    group_name: z.string(),
    service_date: z.string().nullable(),
    service_date_label: z.string().nullable(),
    expected_pax: z.number(),
    planned_pax: z.number(),
    service_pax: z.number(),
    services_total: z.number(),
    services_ready: z.number(),
    services_blocked: z.number(),
    services_already_operational: z.number(),
    warnings: z.array(z.string()),
    bus_reservation: z.record(z.string(), z.unknown()).nullable(),
    ferry: z.record(z.string(), z.unknown()),
    services: z.array(z.record(z.string(), z.unknown())),
    canApply: z.boolean(),
    confirmationToken: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
  allowedRoles: READ_ROLES,
  async handler(context, input) {
    try {
      const res = await previewOperationalizeBookingGroup(context.admin, context.tenantId, input.bookingGroupId);
      if (!res.ok) {
        if (res.status === 404) throw new McpError("MCP_NOT_FOUND", res.error);
        throw new McpError("MCP_INVALID_INPUT", res.error);
      }
      const v = res.data;
      const canApply = v.services_ready > 0;

      // Il token è emesso SOLO se il ruolo può poi eseguirlo (admin/operator).
      // Un supervisor riceve la preview ma nessun token eseguibile (§26).
      let confirmationToken: string | null = null;
      let expiresAt: string | null = null;
      if (canApply && (context.role === "admin" || context.role === "operator")) {
        const generated = generateBookingGroupConfirmationToken({
          op: "operationalize_booking_group",
          userId: context.userId,
          tenantId: context.tenantId,
          groupId: input.bookingGroupId,
          args: {},
        });
        confirmationToken = generated.token;
        expiresAt = generated.expiresAt;
      }

      return {
        booking_group_id: input.bookingGroupId,
        group_name: v.group.name,
        service_date: v.group.service_date ?? null,
        service_date_label: fmtDateIt(v.group.service_date),
        expected_pax: v.expected_pax,
        planned_pax: v.planned_pax,
        service_pax: v.service_pax,
        services_total: v.services_total,
        services_ready: v.services_ready,
        services_blocked: v.services_blocked,
        services_already_operational: v.services_already_operational,
        warnings: v.warnings,
        bus_reservation: (v.bus_reservation as unknown as Record<string, unknown>) ?? null,
        ferry: v.ferry as unknown as Record<string, unknown>,
        services: v.services as unknown as Array<Record<string, unknown>>,
        canApply,
        confirmationToken,
        expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({
    booking_group_id: input.bookingGroupId,
    ready: output.services_ready,
    blocked: output.services_blocked,
    token_issued: Boolean(output.confirmationToken),
  }),
});
