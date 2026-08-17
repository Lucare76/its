import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema } from "@/lib/mcp/schemas/common";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadOperationalVehicles } from "@/lib/server/vehicle-catalog";
import { validateDriverGeographicBatch } from "@/lib/server/geo-assignment";
import {
  checkDriverOverlap,
  checkVehicleOverlap,
  isServiceAssignableForManualAssignment,
} from "@/lib/server/assign-service-core";
import { generateAssignDriverConfirmationToken } from "@/lib/mcp/confirmation";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z
  .object({
    serviceId: uuidSchema,
    driverId: uuidSchema,
    vehicleId: uuidSchema.nullable().optional(),
  })
  .strict();

const conflictSchema = z.object({ code: z.string(), message: z.string() });

const outputSchema = z.object({
  service: z.object({
    id: z.string(),
    date: z.string().nullable(),
    time: z.string().nullable(),
    direction: z.string().nullable(),
    serviceType: z.string().nullable(),
    meetingPoint: z.string().nullable(),
  }),
  driver: z.object({ id: z.string(), name: z.string() }),
  vehicle: z.object({ id: z.string(), label: z.string() }).nullable(),
  currentAssignment: z
    .object({
      driverId: z.string().nullable(),
      driverName: z.string().nullable(),
      vehicleLabel: z.string().nullable(),
    })
    .nullable(),
  conflicts: z.array(conflictSchema),
  warnings: z.array(conflictSchema),
  canAssign: z.boolean(),
  confirmationToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

const SERVICE_SELECT =
  "id, date, time, status, is_draft, direction, pickup_hotel, hotel_id, meeting_point, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, service_type, vessel, ferry_details, pax";

registerTool({
  name: "its.preview_assign_driver",
  description:
    "Anteprima READ-only di un'assegnazione autista(+mezzo) a un servizio: verifica tenant, disponibilita', conflitti orari e stato, senza scrivere nulla. Se assegnabile restituisce un confirmation token da passare a its.assign_driver.",
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

      const drivers = await listDriverRegistry(context.admin, context.tenantId, { activeOnly: false });
      const driver = drivers.find((entry) => entry.id === input.driverId);
      if (!driver) throw new McpError("MCP_NOT_FOUND", "Autista non trovato.");

      let vehicle: { id: string; label: string } | null = null;
      if (input.vehicleId) {
        const vehicles = await loadOperationalVehicles(context.admin, context.tenantId, { activeOnly: false });
        const vehicleRow = vehicles.find((entry) => entry.id === input.vehicleId);
        if (!vehicleRow) throw new McpError("MCP_NOT_FOUND", "Mezzo non trovato.");
        vehicle = { id: vehicleRow.id, label: vehicleRow.label };
      }

      const { data: existingAssignmentRow } = await context.admin
        .from("assignments")
        .select("id, group_id, driver_profile_id, vehicle_label")
        .eq("service_id", input.serviceId)
        .eq("tenant_id", context.tenantId)
        .maybeSingle();

      const existingDriverName = existingAssignmentRow?.driver_profile_id
        ? (drivers.find((entry) => entry.id === existingAssignmentRow.driver_profile_id)?.full_name ?? null)
        : null;
      const currentAssignment = existingAssignmentRow
        ? {
            driverId: (existingAssignmentRow.driver_profile_id as string | null) ?? null,
            driverName: existingDriverName,
            vehicleLabel: ((existingAssignmentRow.vehicle_label as string | null) || null) ?? null,
          }
        : null;

      // FUNC-02 (stato servizio) — regola gia' esistente, riusata invariata.
      if (!isServiceAssignableForManualAssignment(serviceRow as { status?: string | null; is_draft?: boolean | null })) {
        conflicts.push({ code: "SERVICE_NOT_ASSIGNABLE", message: "Il servizio non può essere assegnato nello stato attuale." });
      }

      // FUNC-03 (driver operativo) — stessi segnali gia' aggregati dal registry (active/access_suspended).
      if (!driver.active || driver.access_suspended) {
        conflicts.push({ code: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." });
      }

      // Disponibilita' del giorno confermata — stessa regola hard-block della route.
      const { data: availability } = await context.admin
        .from("daily_availability_confirmations")
        .select("confirmed")
        .eq("tenant_id", context.tenantId)
        .eq("date", serviceRow.date as string)
        .maybeSingle();
      if (!availability?.confirmed) {
        conflicts.push({
          code: "AVAILABILITY_NOT_CONFIRMED",
          message: "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita.",
        });
      }

      // CONC-02 (overlap driver) — stessa funzione condivisa dalla route.
      const driverOverlap = await checkDriverOverlap(
        context.admin,
        context.tenantId,
        {
          serviceId: input.serviceId,
          service: serviceRow as any,
          driverUserId: driver.user_id,
          driverProfileId: driver.id,
          excludeGroupId: existingAssignmentRow?.group_id ?? null,
        },
        { userId: context.userId }
      );
      if (!driverOverlap.ok) {
        conflicts.push({ code: String(driverOverlap.body.error ?? "DRIVER_OVERLAP"), message: String(driverOverlap.body.message ?? "") });
      }

      // Geo validation euristica — solo se il driver ha un account utente collegato.
      if (driver.user_id) {
        const geoValidation = await validateDriverGeographicBatch(context.admin, context.tenantId, driver.user_id, [
          {
            id: serviceRow.id as string,
            date: serviceRow.date as string,
            time: serviceRow.time as string,
            pickup_hotel: serviceRow.pickup_hotel as string | null,
            direction: serviceRow.direction as "arrival" | "departure",
            hotel_id: serviceRow.hotel_id as string | null,
            meeting_point: serviceRow.meeting_point as string | null,
          },
        ]);
        if (!geoValidation.ok) {
          conflicts.push({ code: "GEO_VALIDATION_FAILED", message: geoValidation.error });
        }
      }

      // CONC-03 (overlap mezzo) — stessa funzione condivisa dalla route.
      if (vehicle) {
        const vehicleOverlap = await checkVehicleOverlap(
          context.admin,
          context.tenantId,
          {
            serviceId: input.serviceId,
            service: serviceRow as any,
            vehicleLabel: vehicle.label,
            excludeGroupId: existingAssignmentRow?.group_id ?? null,
          },
          { userId: context.userId }
        );
        if (!vehicleOverlap.ok) {
          conflicts.push({ code: String(vehicleOverlap.body.error ?? "VEHICLE_OVERLAP"), message: String(vehicleOverlap.body.message ?? "") });
        }
      }

      // Warning informativi, non bloccanti (superabili: l'esecuzione resta permessa).
      const requestedVehicleLabel = vehicle?.label ?? null;
      if (currentAssignment) {
        const sameDriver = currentAssignment.driverId === input.driverId;
        const sameVehicle = (currentAssignment.vehicleLabel ?? null) === requestedVehicleLabel;
        if (sameDriver && sameVehicle) {
          warnings.push({ code: "ALREADY_ASSIGNED_SAME", message: "Il servizio è già assegnato esattamente a questo autista/mezzo (nessuna modifica)." });
        } else {
          warnings.push({ code: "REASSIGNMENT", message: "Il servizio ha già un'assegnazione: verrà sovrascritta." });
        }
      }

      const canAssign = conflicts.length === 0;

      let confirmationToken: string | null = null;
      let expiresAt: string | null = null;
      if (canAssign) {
        const generated = generateAssignDriverConfirmationToken({
          userId: context.userId,
          tenantId: context.tenantId,
          serviceId: input.serviceId,
          driverId: input.driverId,
          vehicleId: input.vehicleId ?? null,
        });
        confirmationToken = generated.token;
        expiresAt = generated.expiresAt;
      }

      return {
        service: {
          id: serviceRow.id as string,
          date: (serviceRow.date as string) ?? null,
          time: (serviceRow.time as string) ?? null,
          direction: (serviceRow.direction as string) ?? null,
          serviceType: (serviceRow.service_type as string) ?? (serviceRow.booking_service_kind as string) ?? null,
          meetingPoint: (serviceRow.meeting_point as string) ?? null,
        },
        driver: { id: driver.id, name: driver.full_name },
        vehicle,
        currentAssignment,
        conflicts,
        warnings,
        canAssign,
        confirmationToken,
        expiresAt,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
