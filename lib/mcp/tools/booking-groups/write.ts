/**
 * FASE 3 — Tool MCP WRITE per il dominio GRUPPI PRENOTAZIONE.
 *
 * §29 toolset (WRITE):
 *  - its.create_booking_group
 *  - its.add_booking_group_stop
 *  - its.add_booking_group_passengers
 *  - its.reserve_booking_group_bus
 *  - its.update_booking_group_ferry
 *  - its.operationalize_booking_group
 *
 * Ogni tool WRITE (identico pattern a its.assign_driver / its.update_service_status):
 *  1. input = SOLO { confirmationToken } — args non arrivano dal client;
 *  2. verifica firma HMAC + `op` atteso (verifyBookingGroupConfirmationToken);
 *  3. binding: payload.userId === context.userId && payload.tenantId === context.tenantId;
 *  4. single-use: claimConfirmationToken(payload.jti) PRIMA di qualunque scrittura;
 *  5. ricostruisce la chiamata da payload.args / payload.groupId e delega a
 *     `lib/server/booking-groups-service.ts` — la STESSA logica della route HTTP
 *     (readiness, summarize, operationalize, audit): nessuna copia;
 *  6. audit summary sanitizzato (mai il token, mai PII cliente).
 *
 * Ruoli: admin/operator. Un supervisor è già bloccato a monte dal policy
 * layer (allowedRoles → MCP_FORBIDDEN) e comunque non possiede un token
 * eseguibile (le preview non lo emettono per supervisor).
 */
import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";
import {
  claimConfirmationToken,
  verifyBookingGroupConfirmationToken,
  type BookingGroupConfirmationOp,
  type BookingGroupConfirmationPayload,
} from "@/lib/mcp/confirmation";
import type { McpContext } from "@/lib/mcp/context";
import {
  createBookingGroup,
  addBookingGroupStop,
  addBookingGroupPassengers,
  reserveBookingGroupBus,
  updateBookingGroupFerry,
  operationalizeBookingGroup,
  type BgActor,
  type BgResult,
  type CreateBookingGroupInput,
  type PassengerRow,
  type FerryOverrideKey,
} from "@/lib/server/booking-groups-service";

const WRITE_ROLES = ["admin", "operator"] as const;
const tokenInput = z.object({ confirmationToken: z.string().min(1).max(8000) }).strict();

/**
 * Verifica + binding + single-use. Ritorna il payload validato oppure lancia
 * il McpError corretto. `claimConfirmationToken` è chiamato QUI, prima di
 * qualunque scrittura: da questo momento il token è consumato anche se la
 * delega sottostante fallisce (forza una nuova preview).
 */
function consumeToken(
  context: McpContext,
  token: string,
  expectedOp: BookingGroupConfirmationOp,
): BookingGroupConfirmationPayload {
  const verified = verifyBookingGroupConfirmationToken(token, expectedOp);
  if (!verified.ok) {
    if (verified.reason === "expired") {
      throw new McpError("MCP_CONFIRMATION_EXPIRED", "Il confirmation token e' scaduto. Richiedi una nuova preview.");
    }
    throw new McpError("MCP_CONFIRMATION_INVALID", "Confirmation token non valido.");
  }
  const { payload } = verified;
  if (payload.userId !== context.userId || payload.tenantId !== context.tenantId) {
    throw new McpError("MCP_CONFIRMATION_INVALID", "Confirmation token non valido per questo utente/tenant.");
  }
  if (!claimConfirmationToken(payload.jti)) {
    throw new McpError("MCP_CONFIRMATION_ALREADY_USED", "Questo confirmation token e' gia' stato usato.");
  }
  return payload;
}

function actorOf(context: McpContext): BgActor {
  return { tenantId: context.tenantId, userId: context.userId, role: context.role };
}

/** Mappa un BgErr sul McpError più appropriato. */
function mapErr(res: Extract<BgResult<unknown>, { ok: false }>): never {
  if (res.status === 404) throw new McpError("MCP_NOT_FOUND", res.error);
  if (res.status === 500) throw new McpError("MCP_INTERNAL_ERROR", "Errore interno del server MCP.");
  // 400 / 422 → l'input approvato in preview non è più valido contro lo stato
  // live (dati mancanti, FK di un altro tenant, ecc.) → forza una nuova preview.
  throw new McpError("MCP_CONFIRMATION_STALE", res.error);
}

// ─── its.create_booking_group ──────────────────────────────────────────

registerTool({
  name: "its.create_booking_group",
  description:
    "Esegue la creazione di un gruppo prenotazione precedentemente approvata via its.preview_create_booking_group. Richiede un confirmation token valido, non scaduto, non gia' usato, emesso per lo stesso utente/tenant. Ri-valida le FK (agenzia/hotel) contro lo stato live prima di scrivere.",
  category: "WRITE",
  inputSchema: tokenInput,
  outputSchema: z.object({ bookingGroupId: z.string(), name: z.string(), status: z.string() }),
  allowedRoles: WRITE_ROLES,
  async handler(context, input) {
    try {
      const payload = consumeToken(context, input.confirmationToken, "create_booking_group");
      const a = payload.args as Record<string, unknown>;
      const createInput = {
        name: String(a.name),
        expected_pax: Number(a.expected_pax),
        kind: a.kind as string | undefined,
        status: a.status as string | undefined,
        service_date: (a.service_date as string | null) ?? null,
        contact_name: (a.contact_name as string | null) ?? null,
        contact_phone: (a.contact_phone as string | null) ?? null,
        agency_id: (a.agency_id as string | null) ?? null,
        hotel_id: (a.hotel_id as string | null) ?? null,
        notes: (a.notes as string | null) ?? null,
      } as CreateBookingGroupInput;
      for (const k of Object.keys(a)) {
        if (k.startsWith("outbound_") || k.startsWith("return_")) {
          (createInput as Record<string, unknown>)[k] = a[k] ?? null;
        }
      }
      const res = await createBookingGroup(context.admin, actorOf(context), createInput);
      if (!res.ok) mapErr(res);
      return { bookingGroupId: res.data.group.id, name: res.data.group.name, status: res.data.group.status };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({ booking_group_id: output.bookingGroupId, result: "created" }),
});

// ─── its.add_booking_group_stop ────────────────────────────────────────

registerTool({
  name: "its.add_booking_group_stop",
  description:
    "Esegue l'aggiunta di una fermata pianificata precedentemente approvata via its.preview_add_booking_group_stop. Richiede un confirmation token valido/non usato. NON crea fermate di catalogo.",
  category: "WRITE",
  inputSchema: tokenInput,
  outputSchema: z.object({ bookingGroupStopId: z.string(), bookingGroupId: z.string(), city: z.string() }),
  allowedRoles: WRITE_ROLES,
  async handler(context, input) {
    try {
      const payload = consumeToken(context, input.confirmationToken, "add_booking_group_stop");
      const a = payload.args as Record<string, unknown>;
      const res = await addBookingGroupStop(context.admin, actorOf(context), {
        bookingGroupId: payload.groupId as string,
        city: String(a.city),
        pickup_point: (a.pickup_point as string | null) ?? null,
        expected_pax: Number(a.expected_pax),
        stop_id: (a.stop_id as string | null) ?? null,
        direction: a.direction as "arrival" | "departure",
        sort_order: a.sort_order as number | undefined,
        notes: (a.notes as string | null) ?? null,
      });
      if (!res.ok) mapErr(res);
      return { bookingGroupStopId: res.data.stop.id, bookingGroupId: payload.groupId as string, city: res.data.stop.city };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({ booking_group_id: output.bookingGroupId, booking_group_stop_id: output.bookingGroupStopId, result: "created" }),
});

// ─── its.add_booking_group_passengers ──────────────────────────────────

registerTool({
  name: "its.add_booking_group_passengers",
  description:
    "Esegue la creazione dei servizi bozza per una fermata del gruppo, precedentemente approvata via its.preview_add_booking_group_passengers. Un servizio per nominativo, is_draft=true, status=needs_review. Ri-valida gruppo/fermata/data e le FK hotel contro lo stato live.",
  category: "WRITE",
  inputSchema: tokenInput,
  outputSchema: z.object({
    bookingGroupId: z.string(),
    bookingGroupStopId: z.string(),
    created: z.array(z.object({ id: z.string(), customer_name: z.string(), pax: z.number() })),
    failed: z.array(z.object({ customer_name: z.string(), error: z.string() })),
    created_count: z.number(),
    failed_count: z.number(),
    outcome: z.enum(["created", "partial"]),
  }),
  allowedRoles: WRITE_ROLES,
  async handler(context, input) {
    try {
      const payload = consumeToken(context, input.confirmationToken, "add_booking_group_passengers");
      const a = payload.args as { booking_group_stop_id: string; passengers: PassengerRow[] };
      const res = await addBookingGroupPassengers(context.admin, actorOf(context), {
        bookingGroupId: payload.groupId as string,
        bookingGroupStopId: a.booking_group_stop_id,
        passengers: a.passengers,
      });
      // 404 gruppo / 422 data mancante / 400 hotel di altro tenant → lo stato
      // non è quello approvato in preview: forza una nuova preview.
      if (!("data" in res)) mapErr(res);
      // 200 (tutti creati) o 207 (parziale) → esito strutturato. 500 (tutte
      // le insert fallite) → errore interno.
      if (res.status === 500) {
        throw new McpError("MCP_INTERNAL_ERROR", "Creazione dei servizi non riuscita.");
      }
      return {
        bookingGroupId: payload.groupId as string,
        bookingGroupStopId: a.booking_group_stop_id,
        created: res.data.created,
        failed: res.data.failed,
        created_count: res.data.created_count,
        failed_count: res.data.failed_count,
        outcome: res.data.failed_count === 0 ? ("created" as const) : ("partial" as const),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({
    booking_group_id: output.bookingGroupId,
    booking_group_stop_id: output.bookingGroupStopId,
    created: output.created_count,
    failed: output.failed_count,
  }),
});

// ─── its.reserve_booking_group_bus ─────────────────────────────────────

registerTool({
  name: "its.reserve_booking_group_bus",
  description:
    "Esegue la riserva di un bus per un gruppo in una data, precedentemente approvata via its.preview_reserve_booking_group_bus. Esclusiva date-scoped (upsert su tenant_id+booking_group_id+bus_unit_id+service_date). NON modifica tenant_bus_units.",
  category: "WRITE",
  inputSchema: tokenInput,
  outputSchema: z.object({
    bookingGroupId: z.string(),
    reservationId: z.string(),
    busUnitId: z.string(),
    serviceDate: z.string(),
    reservedPax: z.number(),
  }),
  allowedRoles: WRITE_ROLES,
  async handler(context, input) {
    try {
      const payload = consumeToken(context, input.confirmationToken, "reserve_booking_group_bus");
      const a = payload.args as Record<string, unknown>;
      const res = await reserveBookingGroupBus(context.admin, actorOf(context), {
        bookingGroupId: payload.groupId as string,
        busUnitId: String(a.bus_unit_id),
        service_date: String(a.service_date),
        reserved_pax: Number(a.reserved_pax),
        exclusive: Boolean(a.exclusive),
        notes: (a.notes as string | null) ?? null,
      });
      if (!res.ok) mapErr(res);
      return {
        bookingGroupId: payload.groupId as string,
        reservationId: res.data.reservation.id,
        busUnitId: res.data.reservation.bus_unit_id,
        serviceDate: res.data.reservation.service_date,
        reservedPax: res.data.reservation.reserved_pax,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({
    booking_group_id: output.bookingGroupId,
    bus_unit_id: output.busUnitId,
    service_date: output.serviceDate,
    reserved_pax: output.reservedPax,
  }),
});

// ─── its.update_booking_group_ferry ────────────────────────────────────

registerTool({
  name: "its.update_booking_group_ferry",
  description:
    "Esegue l'aggiornamento dei campi traghetto override del gruppo, precedentemente approvato via its.preview_update_booking_group_ferry. NON tocca bus_line_ferry_config.",
  category: "WRITE",
  inputSchema: tokenInput,
  outputSchema: z.object({ bookingGroupId: z.string(), updatedFields: z.array(z.string()) }),
  allowedRoles: WRITE_ROLES,
  async handler(context, input) {
    try {
      const payload = consumeToken(context, input.confirmationToken, "update_booking_group_ferry");
      const a = payload.args as { ferry?: Partial<Record<FerryOverrideKey, string | null>> };
      const ferry = a.ferry ?? {};
      const res = await updateBookingGroupFerry(context.admin, actorOf(context), {
        bookingGroupId: payload.groupId as string,
        ferry,
      });
      if (!res.ok) mapErr(res);
      return { bookingGroupId: payload.groupId as string, updatedFields: Object.keys(ferry) };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({ booking_group_id: output.bookingGroupId, fields: output.updatedFields }),
});

// ─── its.operationalize_booking_group ──────────────────────────────────

registerTool({
  name: "its.operationalize_booking_group",
  description:
    "Esegue l'operativizzazione dei servizi bozza pronti di un gruppo, precedentemente approvata via its.preview_booking_group_operationalization. Per ogni servizio pronto: is_draft=false, status=new, status_event, auto-allocazione bus best-effort. Ri-valida SEMPRE la readiness live: i servizi non pronti restano bloccati e vengono elencati. Il gruppo passa a 'operational' solo se tutti i suoi servizi bozza sono operativizzati.",
  category: "WRITE",
  inputSchema: tokenInput,
  outputSchema: z.object({
    bookingGroupId: z.string(),
    outcome: z.enum(["operationalized", "partial", "blocked"]),
    operationalized: z.array(z.object({ service_id: z.string(), warnings: z.array(z.string()) })),
    blocked: z.array(z.object({ service_id: z.string(), missing_fields: z.array(z.string()), warnings: z.array(z.string()) })),
    already_operational: z.array(z.string()),
    group_status: z.string(),
  }),
  allowedRoles: WRITE_ROLES,
  async handler(context, input) {
    try {
      const payload = consumeToken(context, input.confirmationToken, "operationalize_booking_group");
      const a = payload.args as { serviceIds?: string[] };
      const res = await operationalizeBookingGroup(context.admin, actorOf(context), {
        bookingGroupId: payload.groupId as string,
        serviceIds: Array.isArray(a.serviceIds) && a.serviceIds.length > 0 ? a.serviceIds : undefined,
      });
      // 404 gruppo → NOT_FOUND. 422/207/200 → risultato strutturato (non un
      // errore: Mario spiega cosa è bloccato).
      if (!("data" in res)) {
        throw new McpError("MCP_NOT_FOUND", res.error);
      }
      const d = res.data;
      const outcome =
        d.operationalized.length > 0 && d.blocked.length === 0
          ? ("operationalized" as const)
          : d.operationalized.length > 0
            ? ("partial" as const)
            : ("blocked" as const);
      return {
        bookingGroupId: payload.groupId as string,
        outcome,
        operationalized: d.operationalized,
        blocked: d.blocked,
        already_operational: d.already_operational,
        group_status: d.group_status,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({
    booking_group_id: output.bookingGroupId,
    outcome: output.outcome,
    operationalized: output.operationalized.length,
    blocked: output.blocked.length,
  }),
});
