/**
 * GET/PATCH ferry_details.connection per un servizio treno/volo — override
 * manuale e ricalcolo Mario (sezione 15 del task).
 *
 * GET  — sola lettura: ricalcola sempre una proposta fresca (mai la fida
 *        ciecamente dal client) e la confronta con l'`applied` persistito.
 *        Nessuna scrittura.
 * PATCH — applica una delle 3 azioni operatore:
 *        - "apply_proposal": la proposta ricalcolata diventa `applied`
 *          (azione esplicita dell'operatore: sostituisce anche un override
 *          manuale precedente, se presente).
 *        - "confirm_override": l'operatore (Mario) sceglie manualmente un
 *          collegamento diverso dalla proposta — `applied.manually_overridden = true`.
 *        - "clear_override": rimuove l'override e torna alla proposta.
 *
 * NON tocca la stampa (piano-giorno-print.ts, PDF): scrive solo
 * services.ferry_details.connection.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { resolveOperationalConnection, type OperationalPickupRule } from "@/lib/operational-connection-resolver";
import { connectionTypeFromKind } from "@/lib/operational-timing-resolver";
import type { FerryScheduleRow, ConnectionRecord } from "@/lib/travel-connection-resolver";
import {
  readFerryConnection,
  writeFerryConnection,
  connectionFromOperationalResult,
  recalculateFerryConnection,
  applyManualOverride,
  clearManualOverride,
} from "@/lib/server/ferry-connection-persistence";

export const runtime = "nodejs";

const ZONE_PATTERN = /forio|lacco|casamicciola|barano|ischia/;

async function loadContext(admin: any, service: any) {
  const [rulesRes, schedulesRes, hotelRes] = await Promise.all([
    admin.from("ferry_pickup_rules").select("*"),
    admin
      .from("ferry_schedules")
      .select("id, company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to"),
    service.hotel_id ? admin.from("hotels").select("id, name, zone").eq("id", service.hotel_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const operationalRules = (rulesRes.data ?? []) as OperationalPickupRule[];
  const ferrySchedules = (schedulesRes.data ?? []) as FerryScheduleRow[];
  const hotel = hotelRes.data as { id: string; name: string; zone: string | null } | null;
  const rawZone = (hotel?.zone ?? "").toLowerCase();
  const zoneRecognized = ZONE_PATTERN.test(rawZone);
  return { operationalRules, ferrySchedules, zone: rawZone || null, zoneRecognized };
}

function resolveForService(
  service: any,
  context: { operationalRules: OperationalPickupRule[]; ferrySchedules: FerryScheduleRow[]; zone: string | null; zoneRecognized: boolean },
  currentOverride: ConnectionRecord | null
) {
  const connectionType = connectionTypeFromKind(service.booking_service_kind);
  if (connectionType !== "train" && connectionType !== "flight") return null;
  const direction = service.direction === "arrival" ? "to_ischia" : "from_ischia";
  const transportTime =
    direction === "from_ischia"
      ? (service.departure_time ?? service.time)?.slice(0, 5)
      : (service.arrival_time ?? service.time)?.slice(0, 5);
  if (!transportTime) return null;
  return resolveOperationalConnection({
    direction,
    bookingServiceKind: service.booking_service_kind ?? "",
    transportTime,
    date: service.date,
    hotelId: service.hotel_id ?? null,
    zone: context.zone,
    zoneRecognized: context.zoneRecognized,
    agencyName: service.billing_party_name ?? null,
    operationalRules: context.operationalRules,
    ferrySchedules: context.ferrySchedules,
    currentOverride,
    pax: service.pax ?? null,
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const { data: service, error } = await auth.admin
    .from("services")
    .select("id, tenant_id, date, direction, time, departure_time, arrival_time, booking_service_kind, hotel_id, billing_party_name, pax, customer_name, ferry_details")
    .eq("id", id)
    .eq("tenant_id", auth.membership.tenant_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!service) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

  const current = readFerryConnection(service.ferry_details as Record<string, unknown> | null);
  const context = await loadContext(auth.admin, service);
  const result = resolveForService(service, context, current?.applied?.manually_overridden ? current.applied : null);
  if (!result) {
    return NextResponse.json({
      service: { id: service.id, customer_name: service.customer_name, pax: service.pax },
      applicable: false,
      reason: "booking_service_kind non è treno/aereo: nessun collegamento nave da gestire qui.",
      current,
    });
  }

  const proposal = connectionFromOperationalResult(result);
  return NextResponse.json({
    service: { id: service.id, customer_name: service.customer_name, pax: service.pax, date: service.date, direction: service.direction },
    applicable: true,
    current,
    proposal,
    hasOverride: current?.applied?.manually_overridden === true,
    hasDiff: JSON.stringify(current?.applied ?? null) !== JSON.stringify(proposal.applied),
  });
}

const overrideRecordSchema = z.object({
  schedule_id: z.string().nullable(),
  company: z.string().nullable(),
  ferry_type: z.enum(["traghetto", "aliscafo"]).nullable(),
  departure_time: z.string().nullable(),
  arrival_time: z.string().nullable(),
  embark_port: z.string().nullable(),
  arrival_port: z.string().nullable(),
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply_proposal") }),
  z.object({ action: z.literal("confirm_override"), connection: overrideRecordSchema, pickup_time: z.string().nullable() }),
  z.object({ action: z.literal("clear_override") }),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Payload non valido.", issues: parsed.error.issues }, { status: 400 });

  const { data: service, error } = await auth.admin
    .from("services")
    .select("id, tenant_id, date, direction, time, departure_time, arrival_time, booking_service_kind, hotel_id, billing_party_name, pax, ferry_details")
    .eq("id", id)
    .eq("tenant_id", auth.membership.tenant_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!service) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

  const current = readFerryConnection(service.ferry_details as Record<string, unknown> | null);
  const confirmedBy = { user_id: auth.user.id, email: auth.user.email ?? null };

  let next;
  if (parsed.data.action === "clear_override") {
    if (!current) return NextResponse.json({ error: "Nessun collegamento salvato da cui rimuovere l'override." }, { status: 400 });
    next = clearManualOverride(current, confirmedBy);
  } else if (parsed.data.action === "confirm_override") {
    next = applyManualOverride(
      current,
      { ...parsed.data.connection, source: "manual", manually_overridden: true },
      parsed.data.pickup_time,
      confirmedBy
    );
  } else {
    // apply_proposal: ricalcola SEMPRE server-side, non si fida di una proposta passata dal client.
    const context = await loadContext(auth.admin, service);
    const result = resolveForService(service, context, null); // azione esplicita: sostituisce anche un override precedente
    if (!result) return NextResponse.json({ error: "booking_service_kind non è treno/aereo." }, { status: 400 });
    next = recalculateFerryConnection(null, result); // current=null -> applied = proposta fresca
  }

  const ferry_details = writeFerryConnection(service.ferry_details as Record<string, unknown> | null, next);
  const { error: updateError } = await auth.admin
    .from("services")
    .update({ ferry_details })
    .eq("id", id)
    .eq("tenant_id", auth.membership.tenant_id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  auditLog({
    event: `ferry_connection_${parsed.data.action}`,
    tenantId: auth.membership.tenant_id,
    userId: auth.user.id,
    serviceId: id,
    details: { next },
  });

  return NextResponse.json({ ok: true, connection: next });
}
