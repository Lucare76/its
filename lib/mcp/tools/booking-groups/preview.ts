/**
 * FASE 3 — Tool MCP PREVIEW-WRITE per il dominio GRUPPI PRENOTAZIONE.
 *
 * §29 toolset (PREVIEW WRITE):
 *  - its.preview_create_booking_group
 *  - its.preview_add_booking_group_stop
 *  - its.preview_add_booking_group_passengers
 *  - its.preview_reserve_booking_group_bus
 *  - its.preview_update_booking_group_ferry
 *
 * Ogni tool:
 *  - è categoria READ, non scrive nulla;
 *  - è consentito solo ad admin/operator: un supervisor riceve MCP_FORBIDDEN
 *    dal policy layer PRIMA dell'handler → nessun token eseguibile emesso (§26);
 *  - fa i controlli live minimi (tenant, esistenza gruppo/fermata/bus unit)
 *    riusando `lib/server/booking-groups-service.ts`;
 *  - costruisce una preview leggibile (date sempre assolute, §21);
 *  - emette un confirmation token opaco (`generateBookingGroupConfirmationToken`)
 *    che il corrispondente tool WRITE ri-valida contro lo stato live.
 */
import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema, isoDateSchema } from "@/lib/mcp/schemas/common";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";
import { BOOKING_GROUP_KINDS, BOOKING_GROUP_MAX_PAX } from "@/lib/booking-groups";
import { generateBookingGroupConfirmationToken } from "@/lib/mcp/confirmation";
import {
  findBookingGroups,
  loadGroupDetail,
  tenantRowExists,
  FERRY_OVERRIDE_KEYS,
} from "@/lib/server/booking-groups-service";
import { fmtDateIt } from "@/lib/mcp/tools/booking-groups/read";

const PREVIEW_ROLES = ["admin", "operator"] as const;
const paxInt = z.number().int().positive().max(BOOKING_GROUP_MAX_PAX);
const clock = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Orario non valido (HH:MM).");

const ferryInputSchema = z
  .object({
    outbound_ferry_company: z.string().trim().max(120).nullable().optional(),
    outbound_departure_port: z.string().trim().max(120).nullable().optional(),
    outbound_ferry_time: clock.nullable().optional(),
    outbound_arrival_port: z.string().trim().max(120).nullable().optional(),
    outbound_expected_arrival_time: clock.nullable().optional(),
    return_ferry_company: z.string().trim().max(120).nullable().optional(),
    return_departure_port: z.string().trim().max(120).nullable().optional(),
    return_ferry_time: clock.nullable().optional(),
    return_arrival_port: z.string().trim().max(120).nullable().optional(),
    return_expected_arrival_time: clock.nullable().optional(),
  })
  .strict();

const tokenFields = {
  confirmationToken: z.string(),
  expiresAt: z.string(),
};

async function requireGroup(admin: unknown, tenantId: string, groupId: string) {
  const found = await findBookingGroups(admin as never, tenantId, { id: groupId });
  const group = found.matches[0];
  if (!group) throw new McpError("MCP_NOT_FOUND", "Gruppo prenotazione non trovato.");
  return group;
}

// ─── its.preview_create_booking_group ───────────────────────────────────

registerTool({
  name: "its.preview_create_booking_group",
  description:
    "Anteprima della creazione di un gruppo prenotazione (contenitore commerciale, nessun servizio creato). Valida nome, pax previsti, tipo, data servizio ed eventuali FK (agenzia/hotel) contro il tenant. Restituisce un confirmation token per its.create_booking_group. Non scrive.",
  category: "READ",
  inputSchema: z
    .object({
      name: z.string().trim().min(1).max(200),
      expectedPax: paxInt,
      kind: z.enum(BOOKING_GROUP_KINDS as unknown as [string, ...string[]]).optional(),
      status: z.string().trim().max(40).optional(),
      serviceDate: isoDateSchema.nullable().optional(),
      contactName: z.string().trim().max(160).nullable().optional(),
      contactPhone: z.string().trim().max(60).nullable().optional(),
      agencyId: uuidSchema.nullable().optional(),
      hotelId: uuidSchema.nullable().optional(),
      notes: z.string().trim().max(4000).nullable().optional(),
      ferry: ferryInputSchema.optional(),
    })
    .strict(),
  outputSchema: z.object({
    name: z.string(),
    expected_pax: z.number(),
    kind: z.string(),
    service_date: z.string().nullable(),
    service_date_label: z.string().nullable(),
    ferry: z.record(z.string(), z.unknown()).nullable(),
    ...tokenFields,
  }),
  allowedRoles: PREVIEW_ROLES,
  async handler(context, input) {
    try {
      if (input.agencyId && !(await tenantRowExists(context.admin, "agencies", context.tenantId, input.agencyId))) {
        throw new McpError("MCP_INVALID_INPUT", "Agenzia non valida per il tenant.");
      }
      if (input.hotelId && !(await tenantRowExists(context.admin, "hotels", context.tenantId, input.hotelId))) {
        throw new McpError("MCP_INVALID_INPUT", "Hotel non valido per il tenant.");
      }

      const args: Record<string, unknown> = {
        name: input.name,
        expected_pax: input.expectedPax,
        kind: input.kind ?? "other",
        status: input.status,
        service_date: input.serviceDate ?? null,
        contact_name: input.contactName ?? null,
        contact_phone: input.contactPhone ?? null,
        agency_id: input.agencyId ?? null,
        hotel_id: input.hotelId ?? null,
        notes: input.notes ?? null,
        ...(input.ferry ?? {}),
      };

      const generated = generateBookingGroupConfirmationToken({
        op: "create_booking_group",
        userId: context.userId,
        tenantId: context.tenantId,
        groupId: null,
        args,
      });

      return {
        name: input.name,
        expected_pax: input.expectedPax,
        kind: input.kind ?? "other",
        service_date: input.serviceDate ?? null,
        service_date_label: fmtDateIt(input.serviceDate ?? null),
        ferry: input.ferry ? (input.ferry as Record<string, unknown>) : null,
        confirmationToken: generated.token,
        expiresAt: generated.expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input) => ({ name_len: input.name.length, expected_pax: input.expectedPax, kind: input.kind ?? "other" }),
});

// ─── its.preview_add_booking_group_stop ─────────────────────────────────

registerTool({
  name: "its.preview_add_booking_group_stop",
  description:
    "Anteprima dell'aggiunta di una fermata pianificata a un gruppo (città + punto di carico + pax previsti). NON crea fermate di catalogo. Segnala se la somma dei pax previsti sulle fermate supererebbe i pax previsti del gruppo (overbooked). Restituisce un confirmation token per its.add_booking_group_stop.",
  category: "READ",
  inputSchema: z
    .object({
      bookingGroupId: uuidSchema,
      city: z.string().trim().min(1).max(160),
      pickupPoint: z.string().trim().max(200).nullable().optional(),
      expectedPax: paxInt,
      stopId: uuidSchema.nullable().optional(),
      direction: z.enum(["arrival", "departure"]),
      sortOrder: z.number().int().min(0).max(9999).optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    })
    .strict(),
  outputSchema: z.object({
    booking_group_id: z.string(),
    group_name: z.string(),
    city: z.string(),
    pickup_point: z.string().nullable(),
    expected_pax: z.number(),
    direction: z.string(),
    planned_pax_before: z.number(),
    planned_pax_after: z.number(),
    group_expected_pax: z.number(),
    warnings: z.array(z.string()),
    ...tokenFields,
  }),
  allowedRoles: PREVIEW_ROLES,
  async handler(context, input) {
    try {
      const group = await requireGroup(context.admin, context.tenantId, input.bookingGroupId);
      if (input.stopId && !(await tenantRowExists(context.admin, "tenant_bus_line_stops", context.tenantId, input.stopId))) {
        throw new McpError("MCP_INVALID_INPUT", "Fermata catalogo non valida per il tenant.");
      }
      const detail = await loadGroupDetail(context.admin, context.tenantId, input.bookingGroupId);
      const plannedBefore = (detail?.stops ?? []).reduce((n, s) => n + Number(s.expected_pax ?? 0), 0);
      const plannedAfter = plannedBefore + input.expectedPax;

      const warnings: string[] = [];
      if (plannedAfter > group.expected_pax) warnings.push("planned_pax_exceeds_group_expected");

      const args: Record<string, unknown> = {
        city: input.city,
        pickup_point: input.pickupPoint ?? null,
        expected_pax: input.expectedPax,
        stop_id: input.stopId ?? null,
        direction: input.direction,
        sort_order: input.sortOrder,
        notes: input.notes ?? null,
      };
      const generated = generateBookingGroupConfirmationToken({
        op: "add_booking_group_stop",
        userId: context.userId,
        tenantId: context.tenantId,
        groupId: input.bookingGroupId,
        args,
      });

      return {
        booking_group_id: input.bookingGroupId,
        group_name: group.name,
        city: input.city,
        pickup_point: input.pickupPoint ?? null,
        expected_pax: input.expectedPax,
        direction: input.direction,
        planned_pax_before: plannedBefore,
        planned_pax_after: plannedAfter,
        group_expected_pax: group.expected_pax,
        warnings,
        confirmationToken: generated.token,
        expiresAt: generated.expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input) => ({ booking_group_id: input.bookingGroupId, city_len: input.city.length, expected_pax: input.expectedPax }),
});

// ─── its.preview_add_booking_group_passengers ───────────────────────────

const passengerInput = z.object({
  customerName: z.string().trim().min(1).max(200),
  pax: paxInt,
  phone: z.string().trim().max(60).nullable().optional(),
  hotelId: uuidSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

registerTool({
  name: "its.preview_add_booking_group_passengers",
  description:
    "Anteprima della creazione di servizi bozza (is_draft) per una fermata pianificata del gruppo, uno per nominativo. Richiede che il gruppo abbia una data servizio. Mostra il totale pax e il residuo rispetto ai pax previsti della fermata. Restituisce un confirmation token per its.add_booking_group_passengers.",
  category: "READ",
  inputSchema: z
    .object({
      bookingGroupId: uuidSchema,
      bookingGroupStopId: uuidSchema,
      passengers: z.array(passengerInput).min(1).max(100),
    })
    .strict(),
  outputSchema: z.object({
    booking_group_id: z.string(),
    booking_group_stop_id: z.string(),
    group_name: z.string(),
    stop_city: z.string().nullable(),
    service_date: z.string().nullable(),
    service_date_label: z.string().nullable(),
    passenger_count: z.number(),
    total_pax: z.number(),
    stop_expected_pax: z.number().nullable(),
    stop_remaining_after: z.number().nullable(),
    warnings: z.array(z.string()),
    ...tokenFields,
  }),
  allowedRoles: PREVIEW_ROLES,
  async handler(context, input) {
    try {
      const detail = await loadGroupDetail(context.admin, context.tenantId, input.bookingGroupId);
      if (!detail) throw new McpError("MCP_NOT_FOUND", "Gruppo prenotazione non trovato.");
      const stop = detail.stops.find((s) => s.id === input.bookingGroupStopId);
      if (!stop) throw new McpError("MCP_NOT_FOUND", "Fermata del gruppo non trovata.");

      const warnings: string[] = [];
      if (!detail.group.service_date) warnings.push("group_service_date_missing");

      for (const p of input.passengers) {
        if (p.hotelId && !(await tenantRowExists(context.admin, "hotels", context.tenantId, p.hotelId))) {
          throw new McpError("MCP_INVALID_INPUT", `Hotel ${p.hotelId} non valido per il tenant.`);
        }
      }

      const totalPax = input.passengers.reduce((n, p) => n + p.pax, 0);
      const stopSummary = detail.stop_summaries.find((s) => s.stopId === input.bookingGroupStopId) ?? null;
      const stopExpected = stopSummary ? stopSummary.expectedPax : null;
      const stopRemainingAfter = stopSummary ? stopSummary.remainingServicePax - totalPax : null;
      if (stopRemainingAfter != null && stopRemainingAfter < 0) warnings.push("stop_pax_overbooked");

      const args: Record<string, unknown> = {
        booking_group_stop_id: input.bookingGroupStopId,
        passengers: input.passengers.map((p) => ({
          customer_name: p.customerName,
          pax: p.pax,
          phone: p.phone ?? null,
          hotel_id: p.hotelId ?? null,
          notes: p.notes ?? null,
        })),
      };
      const generated = generateBookingGroupConfirmationToken({
        op: "add_booking_group_passengers",
        userId: context.userId,
        tenantId: context.tenantId,
        groupId: input.bookingGroupId,
        args,
      });

      return {
        booking_group_id: input.bookingGroupId,
        booking_group_stop_id: input.bookingGroupStopId,
        group_name: detail.group.name,
        stop_city: (stop.city as string | null) ?? null,
        service_date: detail.group.service_date ?? null,
        service_date_label: fmtDateIt(detail.group.service_date),
        passenger_count: input.passengers.length,
        total_pax: totalPax,
        stop_expected_pax: stopExpected,
        stop_remaining_after: stopRemainingAfter,
        warnings,
        confirmationToken: generated.token,
        expiresAt: generated.expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input) => ({
    booking_group_id: input.bookingGroupId,
    booking_group_stop_id: input.bookingGroupStopId,
    passengers: input.passengers.length,
  }),
});

// ─── its.preview_reserve_booking_group_bus ──────────────────────────────

registerTool({
  name: "its.preview_reserve_booking_group_bus",
  description:
    "Anteprima della riserva di un bus (tenant_bus_units) per un gruppo in una data specifica (esclusiva date-scoped). NON modifica tenant_bus_units. Segnala se i pax riservati eccedono la capienza del mezzo o sono sotto i pax previsti del gruppo. Restituisce un confirmation token per its.reserve_booking_group_bus.",
  category: "READ",
  inputSchema: z
    .object({
      bookingGroupId: uuidSchema,
      busUnitId: uuidSchema,
      serviceDate: isoDateSchema,
      reservedPax: paxInt,
      exclusive: z.boolean().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    })
    .strict(),
  outputSchema: z.object({
    booking_group_id: z.string(),
    group_name: z.string(),
    bus_unit_id: z.string(),
    bus_unit_label: z.string().nullable(),
    bus_capacity: z.number().nullable(),
    service_date: z.string(),
    service_date_label: z.string().nullable(),
    reserved_pax: z.number(),
    exclusive: z.boolean(),
    group_expected_pax: z.number(),
    warnings: z.array(z.string()),
    ...tokenFields,
  }),
  allowedRoles: PREVIEW_ROLES,
  async handler(context, input) {
    try {
      const group = await requireGroup(context.admin, context.tenantId, input.bookingGroupId);
      const { data: unit } = await context.admin
        .from("tenant_bus_units")
        .select("id, capacity, tag, group_name")
        .eq("tenant_id", context.tenantId)
        .eq("id", input.busUnitId)
        .maybeSingle();
      if (!unit?.id) throw new McpError("MCP_INVALID_INPUT", "Bus unit non valida per il tenant.");
      const capacity = (unit as { capacity: number | null }).capacity ?? null;
      const label = ((unit as { group_name: string | null; tag: string | null }).group_name || (unit as { tag: string | null }).tag) ?? null;

      const warnings: string[] = [];
      if (capacity != null && input.reservedPax > capacity) warnings.push("reserved_pax_above_capacity");
      if (input.reservedPax < group.expected_pax) warnings.push("reserved_pax_below_group_expected");

      const args: Record<string, unknown> = {
        bus_unit_id: input.busUnitId,
        service_date: input.serviceDate,
        reserved_pax: input.reservedPax,
        exclusive: input.exclusive ?? false,
        notes: input.notes ?? null,
      };
      const generated = generateBookingGroupConfirmationToken({
        op: "reserve_booking_group_bus",
        userId: context.userId,
        tenantId: context.tenantId,
        groupId: input.bookingGroupId,
        args,
      });

      return {
        booking_group_id: input.bookingGroupId,
        group_name: group.name,
        bus_unit_id: input.busUnitId,
        bus_unit_label: label,
        bus_capacity: capacity,
        service_date: input.serviceDate,
        service_date_label: fmtDateIt(input.serviceDate),
        reserved_pax: input.reservedPax,
        exclusive: input.exclusive ?? false,
        group_expected_pax: group.expected_pax,
        warnings,
        confirmationToken: generated.token,
        expiresAt: generated.expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input) => ({ booking_group_id: input.bookingGroupId, bus_unit_id: input.busUnitId, reserved_pax: input.reservedPax }),
});

// ─── its.preview_update_booking_group_ferry ─────────────────────────────

registerTool({
  name: "its.preview_update_booking_group_ferry",
  description:
    "Anteprima dell'aggiornamento dei campi traghetto override del gruppo (andata/ritorno). NON tocca bus_line_ferry_config: sono override commerciali locali al gruppo. Mostra i valori prima/dopo per i soli campi che cambiano. Restituisce un confirmation token per its.update_booking_group_ferry.",
  category: "READ",
  inputSchema: z
    .object({
      bookingGroupId: uuidSchema,
      ferry: ferryInputSchema,
    })
    .strict()
    .refine((v) => Object.keys(v.ferry).length > 0, { message: "Specificare almeno un campo traghetto." }),
  outputSchema: z.object({
    booking_group_id: z.string(),
    group_name: z.string(),
    changes: z.array(z.object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    ...tokenFields,
  }),
  allowedRoles: PREVIEW_ROLES,
  async handler(context, input) {
    try {
      const detail = await loadGroupDetail(context.admin, context.tenantId, input.bookingGroupId);
      if (!detail) throw new McpError("MCP_NOT_FOUND", "Gruppo prenotazione non trovato.");
      const groupRow = detail.group as unknown as Record<string, string | null>;

      const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
      const ferryArgs: Record<string, string | null> = {};
      for (const key of FERRY_OVERRIDE_KEYS) {
        if (!(key in input.ferry)) continue;
        const after = (input.ferry as Record<string, string | null>)[key] ?? null;
        const before = groupRow[key] ?? null;
        ferryArgs[key] = after;
        if (before !== after) changes.push({ field: key, before, after });
      }

      const generated = generateBookingGroupConfirmationToken({
        op: "update_booking_group_ferry",
        userId: context.userId,
        tenantId: context.tenantId,
        groupId: input.bookingGroupId,
        args: { ferry: ferryArgs },
      });

      return {
        booking_group_id: input.bookingGroupId,
        group_name: detail.group.name,
        changes,
        confirmationToken: generated.token,
        expiresAt: generated.expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({ booking_group_id: input.bookingGroupId, changed_fields: output.changes.length }),
});
