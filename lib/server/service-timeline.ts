import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceFieldLabel } from "@/lib/timeline-field-labels";
import { SERVICE_STATUS_LABELS } from "@/lib/ui-labels";
import { SERVICE_AUDIT_EVENT_TYPES } from "@/lib/server/service-audit-events";

/**
 * Timeline/Audit per servizio — aggregatore in LETTURA (nessuna scrittura
 * qui). Unisce, normalizza, deduplica e pagina 7 fonti eterogenee:
 * service_change_logs, status_events, bus_assignment_feedback,
 * driver_assignment_history, service_deletion_log, whatsapp_events,
 * service_audit_events (quest'ultima è l'unica tabella nuova — vedi
 * lib/server/service-audit-events.ts — creata SOLO per i gap non coperti
 * dalle altre 6). Nessuna fonte esistente viene duplicata: questo modulo
 * legge, non riscrive.
 */

export type TimelineEventChange = { field: string; label: string; from: unknown; to: unknown };

export type TimelineActor = {
  type: "human" | "system" | "import" | "provider" | "agency";
  name: string | null;
  email?: string | null;
  userId?: string | null;
};

export type OriginalSource =
  | "service_change_logs"
  | "status_events"
  | "bus_assignment_feedback"
  | "driver_assignment_history"
  | "service_deletion_log"
  | "whatsapp_events"
  | "service_audit_events";

export type TimelineEvent = {
  id: string;
  timestamp: string;
  eventType: string;
  source: string;
  actor: TimelineActor;
  title: string;
  description?: string | null;
  changes?: TimelineEventChange[];
  reason?: string | null;
  severity?: "info" | "warning" | "error";
  originalSource: OriginalSource;
};

export type TimelineCursor = { ts: string; id: string };

const DEFAULT_PAGE_SIZE = 20;
// Buffer di fetch per sorgente: garantisce che la keyset pagination resti
// corretta anche quando molti eventi di più fonti condividono lo stesso
// created_at (caso raro ma possibile — es. un'azione che scrive sia
// service_change_logs sia status_events nella stessa transazione). Per una
// timeline per-SINGOLO-servizio (volume intrinsecamente limitato, non un
// feed tenant-wide) questo buffer è ampiamente sufficiente in pratica.
const FETCH_LIMIT_PER_SOURCE = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function encodeCursor(c: TimelineCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<TimelineCursor>;
    if (typeof parsed.ts === "string" && typeof parsed.id === "string") {
      return { ts: parsed.ts, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

// Ordine totale deterministico: timestamp desc, poi id asc come tie-break.
// L'id (`${originalSource}:${rawId}`) incorpora già la sorgente, quindi non
// serve un campo separato per il tie-break tra fonti diverse allo stesso
// istante — la spec "timestamp + source/originalSource + event_id" è
// soddisfatta dall'id stesso.
function compareDesc(a: TimelineEvent, b: TimelineEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function isStrictlyAfterCursor(e: { timestamp: string; id: string }, c: TimelineCursor): boolean {
  if (e.timestamp !== c.ts) return e.timestamp < c.ts;
  return e.id > c.id;
}

// ── Risoluzione batch dei nomi (mai una query per evento — stesso principio
// di loadServiceFeedbackContexts in lib/server/bus-assignment-feedback.ts) ──

async function resolveUserNames(admin: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return map;
  const { data } = await admin.from("memberships").select("user_id, full_name").eq("tenant_id", tenantId).in("user_id", uniqueIds);
  for (const row of (data ?? []) as Array<{ user_id: string; full_name: string | null }>) {
    if (row.full_name) map.set(row.user_id, row.full_name);
  }
  return map;
}

async function resolveDriverNames(admin: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return map;
  const { data } = await admin.from("driver_profiles").select("id, full_name").eq("tenant_id", tenantId).in("id", uniqueIds);
  for (const row of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
    if (row.full_name) map.set(row.id, row.full_name);
  }
  return map;
}

async function resolveBusUnitNames(admin: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return map;
  const { data } = await admin.from("tenant_bus_units").select("id, label").eq("tenant_id", tenantId).in("id", uniqueIds);
  for (const row of (data ?? []) as Array<{ id: string; label: string | null }>) {
    if (row.label) map.set(row.id, row.label);
  }
  return map;
}

async function resolveBusLineNames(admin: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return map;
  const { data } = await admin.from("tenant_bus_lines").select("id, code, family_code").eq("tenant_id", tenantId).in("id", uniqueIds);
  for (const row of (data ?? []) as Array<{ id: string; code: string | null; family_code: string | null }>) {
    map.set(row.id, row.code ?? row.family_code ?? row.id);
  }
  return map;
}

async function resolveStopNames(admin: SupabaseClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return map;
  const { data } = await admin.from("tenant_bus_line_stops").select("id, stop_name").eq("tenant_id", tenantId).in("id", uniqueIds);
  for (const row of (data ?? []) as Array<{ id: string; stop_name: string | null }>) {
    if (row.stop_name) map.set(row.id, row.stop_name);
  }
  return map;
}

// ── Fetch per sorgente (ognuna filtrata per tenant+servizio, con cursor
// keyset opzionale sulla propria colonna timestamp) ────────────────────────

type ServiceChangeLogRow = {
  id: string;
  action: string;
  changed_fields: string[] | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  operator_user_id: string | null;
  operator_name: string | null;
  operator_email: string | null;
  created_at: string;
};

async function fetchServiceChangeLogs(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("service_change_logs")
    .select("id, action, changed_fields, before_data, after_data, operator_user_id, operator_name, operator_email, created_at")
    .eq("tenant_id", tenantId)
    .or(`service_id.eq.${serviceId},root_service_id.eq.${serviceId}`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("created_at", beforeTs);
  const { data } = await q;
  return (data ?? []) as ServiceChangeLogRow[];
}

type StatusEventRow = { id: string; status: string; at: string; by_user_id: string; notes: string | null };

async function fetchStatusEvents(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("status_events")
    .select("id, status, at, by_user_id, notes")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .order("at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("at", beforeTs);
  const { data } = await q;
  return (data ?? []) as StatusEventRow[];
}

type BusAssignmentFeedbackRow = {
  id: string;
  action_type: string;
  source: string;
  old_bus_unit_id: string | null;
  new_bus_unit_id: string | null;
  old_bus_line_id: string | null;
  new_bus_line_id: string | null;
  old_stop_id: string | null;
  new_stop_id: string | null;
  reason: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

async function fetchBusAssignmentFeedback(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("bus_assignment_feedback")
    .select("id, action_type, source, old_bus_unit_id, new_bus_unit_id, old_bus_line_id, new_bus_line_id, old_stop_id, new_stop_id, reason, created_by_user_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("created_at", beforeTs);
  const { data } = await q;
  return (data ?? []) as BusAssignmentFeedbackRow[];
}

type DriverAssignmentHistoryRow = {
  id: string;
  change_type: string;
  from_driver_profile_id: string | null;
  to_driver_profile_id: string | null;
  from_vehicle_label: string | null;
  to_vehicle_label: string | null;
  operator_id: string;
  created_at: string;
};

async function fetchDriverAssignmentHistory(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("driver_assignment_history")
    .select("id, change_type, from_driver_profile_id, to_driver_profile_id, from_vehicle_label, to_vehicle_label, operator_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("created_at", beforeTs);
  const { data } = await q;
  return (data ?? []) as DriverAssignmentHistoryRow[];
}

type ServiceDeletionLogRow = {
  id: string;
  deleted_by_user_id: string;
  deleted_by_name: string | null;
  deleted_at: string;
  notes: string | null;
};

async function fetchServiceDeletionLog(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("service_deletion_log")
    .select("id, deleted_by_user_id, deleted_by_name, deleted_at, notes")
    .eq("tenant_id", tenantId)
    .eq("original_service_id", serviceId)
    .order("deleted_at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("deleted_at", beforeTs);
  const { data } = await q;
  return (data ?? []) as ServiceDeletionLogRow[];
}

type WhatsappEventRow = { id: string; status: string; template: string | null; happened_at: string };

async function fetchWhatsappEvents(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("whatsapp_events")
    .select("id, status, template, happened_at")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .order("happened_at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("happened_at", beforeTs);
  const { data } = await q;
  return (data ?? []) as WhatsappEventRow[];
}

type ServiceAuditEventRow = {
  id: string;
  event_type: string;
  source: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  reason: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

async function fetchServiceAuditEvents(admin: SupabaseClient, tenantId: string, serviceId: string, beforeTs: string | null, limit: number) {
  let q = admin
    .from("service_audit_events")
    .select("id, event_type, source, actor_user_id, actor_name, actor_email, reason, old_data, new_data, metadata, created_at")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (beforeTs) q = q.lte("created_at", beforeTs);
  const { data } = await q;
  return (data ?? []) as ServiceAuditEventRow[];
}

// ── Normalizzazione: ogni fonte → TimelineEvent, formato comune. La UI non
// conosce nessuno schema di tabella, solo questo formato. ──────────────────

// GAP NOTO (audit go-live, valutato e NON implementato — vedi conversazione):
// il vecchio box "Log modifiche prenotazione" arricchiva i cambi di
// time/arrival_time/pickup_time/departure_time/orario_barca, per servizi
// Formula Traghetto, con dettagli rotta/compagnia (logFerryDetails in
// app/(app)/services/[id]/edit/page.tsx, rimosso con l'evoluzione a
// Cronologia). Costo verificato per ripristinarlo qui: richiede (1) una
// query aggiuntiva sulla riga corrente di `services` per conoscere
// booking_service_kind/hotel_id, (2) loadFerryConnectionContext
// (lib/server/ferry-connection-lookup.ts) — 2 query SENZA scope su
// ferry_pickup_rules/ferry_schedules (tabelle intere), (3) resolveHotelZone
// — 1 query per hotel, fino a 2 volte (andata+ritorno). Non è un caso di
// N+1 per evento (il contesto è calcolato una volta per pagina, non per
// riga), ma SONO 4-5 query sempre eseguite anche per la maggioranza dei
// servizi che non sono Formula Traghetto, più l'accoppiamento di un motore
// di dominio (risoluzione nave) dentro un aggregatore generico pensato per
// restare agnostico. Per questo NON è stato ripristinato in questa
// implementazione — resta un item aperto per il prossimo audit go-live.
function normalizeServiceChangeLog(row: ServiceChangeLogRow): TimelineEvent {
  const fields = row.changed_fields ?? [];
  const changes: TimelineEventChange[] = fields.map((f) => ({
    field: f,
    label: serviceFieldLabel(f),
    from: row.before_data?.[f] ?? null,
    to: row.after_data?.[f] ?? null,
  }));
  const actorName = row.operator_name ?? null;
  let eventType = "service_updated";
  let title = `${actorName ?? "Operatore"} ha modificato ${changes.map((c) => c.label).join(", ") || "il servizio"}`;
  if (row.action === "CREATED") {
    eventType = "service_created";
    title = `${actorName ?? "Operatore"} ha creato il servizio`;
  } else if (row.action === "CANCELLED") {
    eventType = "service_cancelled";
    title = `${actorName ?? "Operatore"} ha annullato il servizio`;
  }
  return {
    id: `service_change_logs:${row.id}`,
    timestamp: row.created_at,
    eventType,
    source: "manual",
    actor: { type: "human", name: actorName, email: row.operator_email ?? null, userId: row.operator_user_id ?? null },
    title,
    changes,
    originalSource: "service_change_logs",
  };
}

function normalizeStatusEvent(row: StatusEventRow, actorName: string | null): TimelineEvent {
  const label = SERVICE_STATUS_LABELS[row.status as keyof typeof SERVICE_STATUS_LABELS] ?? row.status;
  return {
    id: `status_events:${row.id}`,
    timestamp: row.at,
    eventType: "status_change",
    source: "manual",
    actor: { type: "human", name: actorName, userId: row.by_user_id },
    title: `${actorName ?? "Operatore"} ha impostato lo stato: ${label}`,
    description: row.notes ?? null,
    changes: [{ field: "status", label: "stato", from: null, to: row.status }],
    originalSource: "status_events",
  };
}

type BusNameResolvers = {
  busUnit: (id: string | null) => string | null;
  busLine: (id: string | null) => string | null;
  stop: (id: string | null) => string | null;
};

function resolveBusActor(source: string, userId: string | null, name: string | null): TimelineActor {
  if (userId && name) return { type: "human", name, userId };
  if (source === "mario") return { type: "system", name: "Mario" };
  if (source === "auto_assignment" || source === "ml_suggestion") return { type: "system", name: "Sistema" };
  return { type: "human", name: null, userId: userId ?? null };
}

const BUS_ACTION_LABELS: Record<string, string> = {
  initial_allocation: "ha assegnato il bus",
  move: "ha spostato il bus",
  cross_line_move: "ha spostato il servizio di linea",
  stop_change: "ha spostato la fermata",
  delete_allocation: "ha rimosso l'allocazione bus",
  auto_confirmed: "ha confermato l'assegnazione automatica",
  auto_corrected: "ha corretto l'assegnazione automatica",
};

function normalizeBusAssignmentFeedback(row: BusAssignmentFeedbackRow, names: BusNameResolvers, actorName: string | null): TimelineEvent {
  const changes: TimelineEventChange[] = [];
  if (row.old_bus_unit_id !== row.new_bus_unit_id) {
    changes.push({ field: "bus_unit_id", label: "bus", from: names.busUnit(row.old_bus_unit_id), to: names.busUnit(row.new_bus_unit_id) });
  }
  if (row.old_bus_line_id !== row.new_bus_line_id) {
    changes.push({ field: "bus_line_id", label: "linea", from: names.busLine(row.old_bus_line_id), to: names.busLine(row.new_bus_line_id) });
  }
  if (row.old_stop_id !== row.new_stop_id) {
    changes.push({ field: "stop_id", label: "fermata", from: names.stop(row.old_stop_id), to: names.stop(row.new_stop_id) });
  }
  const actor = resolveBusActor(row.source, row.created_by_user_id, actorName);
  const verb = BUS_ACTION_LABELS[row.action_type] ?? "ha modificato l'assegnazione bus";
  let title = `${actor.name ?? "Operatore"} ${verb}`;
  if (row.action_type === "stop_change") {
    const stopChange = changes.find((c) => c.field === "stop_id");
    if (stopChange?.from && stopChange?.to) title = `${actor.name ?? "Operatore"} ha spostato la fermata da ${stopChange.from} a ${stopChange.to}`;
  } else if (row.action_type === "initial_allocation") {
    const unitChange = changes.find((c) => c.field === "bus_unit_id");
    if (unitChange?.to) title = `${actor.name ?? "Operatore"} ha assegnato il bus ${unitChange.to}`;
  } else if (row.action_type === "move") {
    const unitChange = changes.find((c) => c.field === "bus_unit_id");
    if (unitChange?.from && unitChange?.to) title = `${actor.name ?? "Operatore"} ha spostato il bus da ${unitChange.from} a ${unitChange.to}`;
  }
  return {
    id: `bus_assignment_feedback:${row.id}`,
    timestamp: row.created_at,
    eventType: `bus_${row.action_type}`,
    source: row.source,
    actor,
    title,
    reason: row.reason ?? null,
    changes,
    originalSource: "bus_assignment_feedback",
  };
}

function normalizeDriverAssignmentHistory(row: DriverAssignmentHistoryRow, driverNames: Map<string, string>, operatorNames: Map<string, string>): TimelineEvent {
  const changes: TimelineEventChange[] = [];
  if (row.from_driver_profile_id !== row.to_driver_profile_id) {
    changes.push({
      field: "driver",
      label: "autista",
      from: row.from_driver_profile_id ? driverNames.get(row.from_driver_profile_id) ?? null : null,
      to: row.to_driver_profile_id ? driverNames.get(row.to_driver_profile_id) ?? null : null,
    });
  }
  if ((row.from_vehicle_label ?? null) !== (row.to_vehicle_label ?? null)) {
    changes.push({ field: "vehicle", label: "mezzo", from: row.from_vehicle_label ?? null, to: row.to_vehicle_label ?? null });
  }
  const isAuto = row.change_type === "auto_assign_accepted";
  const actor: TimelineActor = isAuto
    ? { type: "system", name: "Sistema" }
    : { type: "human", name: operatorNames.get(row.operator_id) ?? null, userId: row.operator_id };
  const driverToName = row.to_driver_profile_id ? driverNames.get(row.to_driver_profile_id) ?? null : null;
  let title: string;
  if (row.change_type === "driver_swap") {
    title = `${actor.name ?? "Operatore"} ha assegnato ${driverToName ? `l'autista ${driverToName}` : "un autista"}`;
  } else if (row.change_type === "vehicle_binding") {
    title = `${actor.name ?? "Operatore"} ha assegnato il mezzo${row.to_vehicle_label ? ` ${row.to_vehicle_label}` : ""}`;
  } else if (row.change_type === "auto_assign_accepted") {
    title = "Sistema ha assegnato automaticamente autista/mezzo";
  } else {
    title = `${actor.name ?? "Operatore"} ha applicato un suggerimento di risoluzione`;
  }
  return {
    id: `driver_assignment_history:${row.id}`,
    timestamp: row.created_at,
    eventType: row.change_type,
    source: isAuto ? "auto_assignment" : "manual",
    actor,
    title,
    changes,
    originalSource: "driver_assignment_history",
  };
}

function normalizeServiceDeletionLog(row: ServiceDeletionLogRow): TimelineEvent {
  return {
    id: `service_deletion_log:${row.id}`,
    timestamp: row.deleted_at,
    eventType: "service_deleted",
    source: "manual",
    actor: { type: "human", name: row.deleted_by_name ?? null, userId: row.deleted_by_user_id },
    title: `${row.deleted_by_name ?? "Operatore"} ha cancellato definitivamente il servizio`,
    reason: row.notes ?? null,
    severity: "warning",
    originalSource: "service_deletion_log",
  };
}

const WHATSAPP_STATUS_LABEL: Record<string, string> = {
  queued: "in coda",
  sent: "inviato",
  delivered: "consegnato",
  read: "letto",
  failed: "fallito",
};

function normalizeWhatsappEvent(row: WhatsappEventRow): TimelineEvent {
  return {
    id: `whatsapp_events:${row.id}`,
    timestamp: row.happened_at,
    eventType: "whatsapp_message",
    source: "system",
    actor: { type: "provider", name: "WhatsApp" },
    title: `Messaggio WhatsApp ${WHATSAPP_STATUS_LABEL[row.status] ?? row.status}${row.template ? ` (${row.template})` : ""}`,
    severity: row.status === "failed" ? "warning" : "info",
    originalSource: "whatsapp_events",
  };
}

const IMPORT_SOURCE_LABEL: Record<string, string> = {
  import_excel: "Excel",
  import_pdf: "PDF agenzia",
  import_email: "email",
  import_mts_globe: "MTS Globe",
};

function buildServiceAuditEventChanges(row: ServiceAuditEventRow): TimelineEventChange[] {
  const before = row.old_data ?? {};
  const after = row.new_data ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].map((k) => ({ field: k, label: serviceFieldLabel(k), from: before[k] ?? null, to: after[k] ?? null }));
}

function normalizeServiceAuditEvent(row: ServiceAuditEventRow, resolvedActorName: string | null): TimelineEvent {
  const actorType: TimelineActor["type"] = row.source.startsWith("import_")
    ? "import"
    : row.source === "agency_portal"
      ? "agency"
      : row.source === "system"
        ? "system"
        : "human";
  // Alcuni call site (es. assign-service-core.ts, path "remove") non
  // risolvono il nome al momento della scrittura per non aggiungere una
  // query a un percorso oggi senza query a memberships — qui viene risolto
  // in lettura, batch, stesso principio di status_events/driver_assignment_history.
  const actor: TimelineActor = {
    type: actorType,
    name: row.actor_name ?? resolvedActorName ?? (actorType === "system" ? "Sistema" : null),
    email: row.actor_email ?? null,
    userId: row.actor_user_id ?? null,
  };
  const changes = buildServiceAuditEventChanges(row);
  let title: string;
  switch (row.event_type) {
    case SERVICE_AUDIT_EVENT_TYPES.SERVICE_RESTORED:
      title = `${actor.name ?? "Operatore"} ha ripristinato il servizio`;
      break;
    case SERVICE_AUDIT_EVENT_TYPES.DRIVER_REMOVED:
      title = `${actor.name ?? "Operatore"} ha rimosso l'autista`;
      break;
    case SERVICE_AUDIT_EVENT_TYPES.VEHICLE_REMOVED:
      title = `${actor.name ?? "Operatore"} ha rimosso il mezzo`;
      break;
    case SERVICE_AUDIT_EVENT_TYPES.SERVICE_IMPORTED:
      title = `Import ${IMPORT_SOURCE_LABEL[row.source] ?? row.source} ha creato il servizio`;
      break;
    case SERVICE_AUDIT_EVENT_TYPES.AGENCY_APPROVED:
      title = `${actor.name ?? "Operatore"} ha approvato la richiesta agenzia`;
      break;
    case SERVICE_AUDIT_EVENT_TYPES.AGENCY_REJECTED:
      title = `${actor.name ?? "Operatore"} ha rifiutato la richiesta agenzia`;
      break;
    case SERVICE_AUDIT_EVENT_TYPES.BOOKING_GROUP_SERVICE_CREATED:
      title = `${actor.name ?? "Operatore"} ha creato il servizio dal gruppo prenotazioni`;
      break;
    default:
      title = `${actor.name ?? "Operatore"} — ${row.event_type.replace(/_/g, " ")}`;
  }
  return {
    id: `service_audit_events:${row.id}`,
    timestamp: row.created_at,
    eventType: row.event_type,
    source: row.source,
    actor,
    title,
    reason: row.reason ?? null,
    changes,
    originalSource: "service_audit_events",
  };
}

// ── Dedup: strategia esplicita di precedenza (mai un confronto sul testo
// visualizzato — sempre su campo/semantica + finestra temporale). ──────────

const DEDUP_WINDOW_MS = 5000;
const BUS_FIELDS = new Set(["bus_unit_id", "bus_line_id", "stop_id"]);
const DRIVER_VEHICLE_FIELDS = new Set(["driver_user_id", "driver_profile_id", "vehicle_label", "driver", "vehicle"]);

function withinWindow(aIso: string, bIso: string, windowMs: number): boolean {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) <= windowMs;
}

function changeTo(e: TimelineEvent, field: string): unknown {
  return e.changes?.find((c) => c.field === field)?.to;
}

/**
 * Regole di precedenza (documentate esplicitamente, non desumibili dal solo
 * testo mostrato):
 *  - status: service_change_logs (ha old+new) vince su status_events (solo new).
 *  - bus/linea/fermata: bus_assignment_feedback (il più ricco) vince su service_change_logs.
 *  - autista/veicolo: driver_assignment_history vince su service_change_logs.
 *  - hard delete: service_deletion_log è l'unica fonte autorevole, vince su
 *    un eventuale service_change_logs "CANCELLED" alla stessa finestra
 *    temporale (edge case difensivo: in pratica service_change_logs viene
 *    già cancellato ON DELETE CASCADE insieme al servizio).
 */
export function dedupeTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  const suppressed = new Set<string>();

  const changeLogs = events.filter((e) => e.originalSource === "service_change_logs");
  const statusEvents = events.filter((e) => e.originalSource === "status_events");
  const busEvents = events.filter((e) => e.originalSource === "bus_assignment_feedback");
  const driverEvents = events.filter((e) => e.originalSource === "driver_assignment_history");
  const deletionEvents = events.filter((e) => e.originalSource === "service_deletion_log");

  for (const log of changeLogs) {
    const statusValue = changeTo(log, "status");
    if (statusValue == null) continue;
    const match = statusEvents.find(
      (s) => !suppressed.has(s.id) && withinWindow(s.timestamp, log.timestamp, DEDUP_WINDOW_MS) && changeTo(s, "status") === statusValue
    );
    if (match) suppressed.add(match.id);
  }

  for (const log of changeLogs) {
    if (suppressed.has(log.id)) continue;
    if (!log.changes?.some((c) => BUS_FIELDS.has(c.field))) continue;
    const match = busEvents.find((b) => !suppressed.has(b.id) && withinWindow(b.timestamp, log.timestamp, DEDUP_WINDOW_MS));
    if (match) suppressed.add(log.id);
  }

  for (const log of changeLogs) {
    if (suppressed.has(log.id)) continue;
    if (!log.changes?.some((c) => DRIVER_VEHICLE_FIELDS.has(c.field))) continue;
    const match = driverEvents.find((d) => !suppressed.has(d.id) && withinWindow(d.timestamp, log.timestamp, DEDUP_WINDOW_MS));
    if (match) suppressed.add(log.id);
  }

  for (const log of changeLogs) {
    if (suppressed.has(log.id)) continue;
    if (log.eventType !== "service_cancelled") continue;
    const match = deletionEvents.find((d) => !suppressed.has(d.id) && withinWindow(d.timestamp, log.timestamp, DEDUP_WINDOW_MS));
    if (match) suppressed.add(log.id);
  }

  return events.filter((e) => !suppressed.has(e.id));
}

// ── Orchestratore: fetch parallelo per sorgente, risoluzione nomi batch,
// normalizzazione, dedup, keyset pagination. ───────────────────────────────

export type ServiceTimelinePage = { events: TimelineEvent[]; nextCursor: string | null };

export async function getServiceTimelinePage(
  admin: SupabaseClient,
  input: { tenantId: string; serviceId: string; cursor?: string | null; pageSize?: number }
): Promise<ServiceTimelinePage> {
  if (!isValidUuid(input.serviceId)) return { events: [], nextCursor: null };

  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const cursor = decodeCursor(input.cursor ?? null);
  const beforeTs = cursor?.ts ?? null;
  const fetchLimit = Math.max(FETCH_LIMIT_PER_SOURCE, pageSize * 3);

  const [changeLogs, statusEvents, busFeedback, driverHistory, deletionLogs, whatsapp, auditEvents] = await Promise.all([
    fetchServiceChangeLogs(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
    fetchStatusEvents(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
    fetchBusAssignmentFeedback(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
    fetchDriverAssignmentHistory(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
    fetchServiceDeletionLog(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
    fetchWhatsappEvents(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
    fetchServiceAuditEvents(admin, input.tenantId, input.serviceId, beforeTs, fetchLimit),
  ]);

  const truncated = [changeLogs, statusEvents, busFeedback, driverHistory, deletionLogs, whatsapp, auditEvents].some(
    (rows) => rows.length >= fetchLimit
  );

  const userIds = new Set<string>();
  for (const r of changeLogs) if (r.operator_user_id) userIds.add(r.operator_user_id);
  for (const r of statusEvents) if (r.by_user_id) userIds.add(r.by_user_id);
  for (const r of busFeedback) if (r.created_by_user_id) userIds.add(r.created_by_user_id);
  for (const r of driverHistory) userIds.add(r.operator_id);
  for (const r of auditEvents) if (r.actor_user_id && !r.actor_name) userIds.add(r.actor_user_id);

  const driverProfileIds = new Set<string>();
  for (const r of driverHistory) {
    if (r.from_driver_profile_id) driverProfileIds.add(r.from_driver_profile_id);
    if (r.to_driver_profile_id) driverProfileIds.add(r.to_driver_profile_id);
  }

  const busUnitIds = new Set<string>();
  const busLineIds = new Set<string>();
  const stopIds = new Set<string>();
  for (const r of busFeedback) {
    if (r.old_bus_unit_id) busUnitIds.add(r.old_bus_unit_id);
    if (r.new_bus_unit_id) busUnitIds.add(r.new_bus_unit_id);
    if (r.old_bus_line_id) busLineIds.add(r.old_bus_line_id);
    if (r.new_bus_line_id) busLineIds.add(r.new_bus_line_id);
    if (r.old_stop_id) stopIds.add(r.old_stop_id);
    if (r.new_stop_id) stopIds.add(r.new_stop_id);
  }

  const [userNames, driverNames, busUnitNames, busLineNames, stopNames] = await Promise.all([
    resolveUserNames(admin, input.tenantId, [...userIds]),
    resolveDriverNames(admin, input.tenantId, [...driverProfileIds]),
    resolveBusUnitNames(admin, input.tenantId, [...busUnitIds]),
    resolveBusLineNames(admin, input.tenantId, [...busLineIds]),
    resolveStopNames(admin, input.tenantId, [...stopIds]),
  ]);

  const busNameResolvers: BusNameResolvers = {
    busUnit: (id) => (id ? busUnitNames.get(id) ?? null : null),
    busLine: (id) => (id ? busLineNames.get(id) ?? null : null),
    stop: (id) => (id ? stopNames.get(id) ?? null : null),
  };

  const events: TimelineEvent[] = [
    ...changeLogs.map(normalizeServiceChangeLog),
    ...statusEvents.map((r) => normalizeStatusEvent(r, userNames.get(r.by_user_id) ?? null)),
    ...busFeedback.map((r) => normalizeBusAssignmentFeedback(r, busNameResolvers, r.created_by_user_id ? userNames.get(r.created_by_user_id) ?? null : null)),
    ...driverHistory.map((r) => normalizeDriverAssignmentHistory(r, driverNames, userNames)),
    ...deletionLogs.map(normalizeServiceDeletionLog),
    ...whatsapp.map(normalizeWhatsappEvent),
    ...auditEvents.map((r) => normalizeServiceAuditEvent(r, r.actor_user_id ? userNames.get(r.actor_user_id) ?? null : null)),
  ];

  const deduped = dedupeTimelineEvents(events);
  const filtered = cursor ? deduped.filter((e) => isStrictlyAfterCursor(e, cursor)) : deduped;
  const sorted = [...filtered].sort(compareDesc);

  const hasMore = sorted.length > pageSize || truncated;
  const page = sorted.slice(0, pageSize);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ ts: last.timestamp, id: last.id }) : null;

  return { events: page, nextCursor };
}
