/**
 * Orchestratore Mario Assistant (Sprint 6) — collega intent riconosciuto ->
 * tool MCP READ Sprint 5 -> risposta business-oriented. Nessun LLM, nessuna
 * seconda pipeline: chiama runTool esattamente come farebbe il transport
 * stdio (policy -> rate limit -> validazione -> handler -> audit), il
 * client NON sceglie mai il tool.
 */
import { getTool } from "@/lib/mcp/registry";
import { runTool } from "@/lib/mcp/server";
import type { McpContext } from "@/lib/mcp/context";
import { detectMarioIntent, UNSUPPORTED_ANSWER, WRITE_UNSUPPORTED_ANSWER, type MarioIntentResult } from "./intent-parser";
import {
  formatOperationalBriefAnswer,
  formatHealthStatusAnswer,
  formatAlertsAnswer,
  formatUnassignedAnswer,
  formatDriverAvailabilityAnswer,
  formatAssignmentPlanAnswer,
  formatAssignmentExceptionsAnswer,
  type OperationalBriefOutput,
  type HealthStatusOutput,
  type OperationalAlertsOutput,
  type UnassignedServicesOutput,
  type DriverAvailabilityOutput,
  type AssignmentPlanOutput,
  type AssignmentExceptionsOutput,
} from "./answer-formatter";

export type MarioAssistantResult = {
  intent: string;
  answer: string;
  actions: Array<{ label: string; href: string }>;
  data?: unknown;
};

/** Un tool MCP fallito produce un errore leggibile, mai uno stack trace o il codice McpError grezzo. */
const FAILURE_MESSAGE_BY_INTENT: Record<string, string> = {
  operational_brief: "Al momento non riesco a leggere la situazione della giornata.",
  health_status: "Al momento non riesco a leggere lo stato di salute di ITS.",
  alerts: "Al momento non riesco a leggere gli alert.",
  unassigned: "Al momento non riesco a leggere i servizi senza autista.",
  driver_availability: "Al momento non riesco a leggere la disponibilità autisti.",
  assignment_plan: "Al momento non riesco a leggere il piano di assegnazione.",
  assignment_exceptions: "Al momento non riesco a leggere le eccezioni del piano di assegnazione.",
};

const TOOL_NAME_BY_INTENT: Record<string, string> = {
  operational_brief: "its.get_operational_brief",
  health_status: "its.get_health_status",
  alerts: "its.get_operational_alerts",
  unassigned: "its.get_unassigned_services",
  driver_availability: "its.get_driver_availability",
  assignment_plan: "its.get_assignment_plan",
  assignment_exceptions: "its.get_assignment_exceptions",
};

function isMcpToolContentResult(value: unknown): value is { isError?: boolean; content: Array<{ type: string; text?: string }> } {
  return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

/** Chiama un tool MCP per nome via la STESSA pipeline (runTool). Ritorna il
 *  JSON parsato dell'output, oppure { __error: code } se il tool ha fallito. */
async function callTool(
  context: McpContext,
  name: string,
  input: unknown,
): Promise<Record<string, unknown> | { __error: string }> {
  const tool = getTool(name);
  if (!tool) return { __error: "MCP_NOT_FOUND" };
  const raw = await runTool(context, tool, input);
  if (!isMcpToolContentResult(raw)) return { __error: "MCP_INTERNAL_ERROR" };
  const text = raw.content[0]?.text;
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return { __error: "MCP_INTERNAL_ERROR" };
  }
  if (raw.isError) {
    const code = (parsed as { code?: string } | null)?.code ?? "MCP_INTERNAL_ERROR";
    return { __error: code };
  }
  return (parsed as Record<string, unknown>) ?? {};
}

const BG_ACTIONS = [{ label: "Apri Gruppi prenotazione", href: "/booking-groups" }];

type BgMatch = { id: string; name: string; expected_pax: number; status: string; service_date_label: string | null };

async function resolveSingleBookingGroup(
  context: McpContext,
  query: string | undefined,
  date: string | undefined,
): Promise<
  | { kind: "ok"; group: BgMatch }
  | { kind: "missing_query" }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: BgMatch[] }
  | { kind: "error" }
> {
  if (!query) return { kind: "missing_query" };
  const res = await callTool(context, "its.find_booking_group", { query, ...(date ? { serviceDate: date } : {}) });
  if ("__error" in res) return { kind: "error" };
  const matches = (res.matches as BgMatch[] | undefined) ?? [];
  if (matches.length === 0) return { kind: "none" };
  if (res.ambiguous || matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "ok", group: matches[0]! };
}

function listGroupsText(matches: BgMatch[]): string {
  return matches
    .map((m) => `• ${m.name} — ${m.expected_pax} pax, stato ${m.status}${m.service_date_label ? `, ${m.service_date_label}` : ""}`)
    .join("\n");
}

async function runBookingGroupIntent(
  context: McpContext,
  detected: Extract<MarioIntentResult, { intent: `booking_group_${string}` }>,
): Promise<MarioAssistantResult> {
  const query = detected.params.query;
  const date = detected.params.date;

  // WRITE: l'orchestratore deterministico non porta a termine da solo lo
  // scambio token; indirizza al flusso guidato anteprima → conferma senza mai
  // inventare i dati mancanti (§23) e senza esporre token (§24).
  if (detected.intent === "booking_group_write") {
    let ctx = "";
    if (query) {
      const resolved = await resolveSingleBookingGroup(context, query, date);
      if (resolved.kind === "ok") {
        ctx = ` Il gruppo «${resolved.group.name}» risulta a ${resolved.group.expected_pax} pax previsti, stato ${resolved.group.status}.`;
      } else if (resolved.kind === "ambiguous") {
        return {
          intent: detected.intent,
          answer: `Ci sono più gruppi che corrispondono a «${query}». Quale intendi?\n${listGroupsText(resolved.matches)}`,
          actions: BG_ACTIONS,
          data: { matches: resolved.matches },
        };
      }
    }
    return {
      intent: detected.intent,
      answer:
        "Creare o modificare un gruppo prenotazione passa sempre da un'anteprima e una conferma esplicita." +
        ctx +
        " Dimmi cosa vuoi fare e i dati necessari (nome gruppo, pax previsti, data, fermata, nominativi…): ti mostro l'anteprima prima di applicare qualcosa. In alternativa puoi procedere da Gruppi prenotazione.",
      actions: BG_ACTIONS,
    };
  }

  // FIND
  if (detected.intent === "booking_group_find") {
    if (!query) {
      return { intent: detected.intent, answer: "Di quale gruppo prenotazione? Dimmi il nome (anche parziale).", actions: BG_ACTIONS };
    }
    const res = await callTool(context, "its.find_booking_group", { query, ...(date ? { serviceDate: date } : {}) });
    if ("__error" in res) {
      return { intent: detected.intent, answer: "Al momento non riesco a cercare i gruppi prenotazione.", actions: BG_ACTIONS };
    }
    const matches = (res.matches as BgMatch[] | undefined) ?? [];
    if (matches.length === 0) {
      return { intent: detected.intent, answer: `Nessun gruppo prenotazione trovato per «${query}».`, actions: BG_ACTIONS, data: res };
    }
    if (res.ambiguous || matches.length > 1) {
      return {
        intent: detected.intent,
        answer: `Ho trovato più gruppi per «${query}». Quale intendi?\n${listGroupsText(matches)}`,
        actions: BG_ACTIONS,
        data: res,
      };
    }
    const g = matches[0]!;
    return {
      intent: detected.intent,
      answer: `Gruppo «${g.name}»: ${g.expected_pax} pax previsti, stato ${g.status}${g.service_date_label ? `, data ${g.service_date_label}` : ""}.`,
      actions: BG_ACTIONS,
      data: res,
    };
  }

  // DETAIL
  if (detected.intent === "booking_group_detail") {
    const resolved = await resolveSingleBookingGroup(context, query, date);
    if (resolved.kind === "missing_query") {
      return { intent: detected.intent, answer: "Di quale gruppo vuoi il dettaglio? Dimmi il nome.", actions: BG_ACTIONS };
    }
    if (resolved.kind === "none") {
      return { intent: detected.intent, answer: `Nessun gruppo prenotazione trovato per «${query}».`, actions: BG_ACTIONS };
    }
    if (resolved.kind === "ambiguous") {
      return { intent: detected.intent, answer: `Più gruppi per «${query}». Quale?\n${listGroupsText(resolved.matches)}`, actions: BG_ACTIONS, data: { matches: resolved.matches } };
    }
    if (resolved.kind === "error") {
      return { intent: detected.intent, answer: "Al momento non riesco a leggere il gruppo prenotazione.", actions: BG_ACTIONS };
    }
    const detail = await callTool(context, "its.get_booking_group_detail", { bookingGroupId: resolved.group.id });
    if ("__error" in detail) {
      return { intent: detected.intent, answer: "Al momento non riesco a leggere il dettaglio del gruppo.", actions: BG_ACTIONS };
    }
    const summary = (detail.summary as { pax?: Record<string, number> } | undefined)?.pax ?? {};
    const stops = (detail.stops as unknown[] | undefined)?.length ?? 0;
    const services = (detail.services as unknown[] | undefined)?.length ?? 0;
    return {
      intent: detected.intent,
      answer:
        `Gruppo «${resolved.group.name}» — ${summary.expectedPax ?? resolved.group.expected_pax} pax previsti, ` +
        `${summary.plannedPax ?? 0} pianificati sulle fermate (${stops}), ${summary.servicePax ?? 0} già in servizi (${services}). ` +
        `Gap servizi: ${summary.remainingServicePax ?? "-"}.`,
      actions: BG_ACTIONS,
      data: detail,
    };
  }

  // INSPECT (readiness / operativizzabilità)
  const resolved = await resolveSingleBookingGroup(context, query, date);
  if (resolved.kind === "missing_query") {
    return { intent: detected.intent, answer: "Di quale gruppo vuoi verificare la completezza? Dimmi il nome.", actions: BG_ACTIONS };
  }
  if (resolved.kind === "none") {
    return { intent: detected.intent, answer: `Nessun gruppo prenotazione trovato per «${query}».`, actions: BG_ACTIONS };
  }
  if (resolved.kind === "ambiguous") {
    return { intent: detected.intent, answer: `Più gruppi per «${query}». Quale?\n${listGroupsText(resolved.matches)}`, actions: BG_ACTIONS, data: { matches: resolved.matches } };
  }
  if (resolved.kind === "error") {
    return { intent: detected.intent, answer: "Al momento non riesco a verificare il gruppo prenotazione.", actions: BG_ACTIONS };
  }
  const view = await callTool(context, "its.preview_booking_group_operationalization", { bookingGroupId: resolved.group.id });
  if ("__error" in view) {
    return { intent: detected.intent, answer: "Al momento non riesco a verificare l'operativizzabilità del gruppo.", actions: BG_ACTIONS };
  }
  const ready = Number(view.services_ready ?? 0);
  const blocked = Number(view.services_blocked ?? 0);
  const already = Number(view.services_already_operational ?? 0);
  const warnings = (view.warnings as string[] | undefined) ?? [];
  // §24 — il confirmationToken NON compare mai nel testo per l'utente: resta
  // solo in `data` per un eventuale layer che gestisce la conferma.
  const parts = [
    `Gruppo «${resolved.group.name}»: ${ready} servizi pronti, ${blocked} bloccati, ${already} già operativi.`,
  ];
  if (blocked > 0) {
    const blockedSvc = (view.services as Array<{ ready?: boolean; already_operational?: boolean; missing_fields?: string[] }> | undefined) ?? [];
    const missing = new Set<string>();
    for (const s of blockedSvc) if (!s.ready && !s.already_operational) (s.missing_fields ?? []).forEach((f) => missing.add(f));
    if (missing.size) parts.push(`Mancano: ${[...missing].join(", ")}.`);
  }
  if (warnings.length) parts.push(`Attenzione: ${warnings.join(", ")}.`);
  if (ready > 0) parts.push("Posso preparare l'operativizzazione dei servizi pronti: confermi?");
  return { intent: detected.intent, answer: parts.join(" "), actions: BG_ACTIONS, data: view };
}

export async function runMarioAssistant(
  context: McpContext,
  message: string,
  now: Date = new Date()
): Promise<MarioAssistantResult> {
  const detected = detectMarioIntent(message, now);

  if (detected.intent === "unsupported") {
    return { intent: "unsupported", answer: UNSUPPORTED_ANSWER, actions: [] };
  }
  if (detected.intent === "write_unsupported") {
    return { intent: "write_unsupported", answer: WRITE_UNSUPPORTED_ANSWER, actions: [] };
  }

  // FASE 3 — gruppi prenotazione: READ via tool MCP, WRITE indirizzata al
  // flusso anteprima → conferma (stessa pipeline runTool, nessun secondo motore).
  if (detected.intent.startsWith("booking_group_")) {
    return runBookingGroupIntent(context, detected as Extract<MarioIntentResult, { intent: `booking_group_${string}` }>);
  }

  const toolName = TOOL_NAME_BY_INTENT[detected.intent];
  const tool = toolName ? getTool(toolName) : undefined;
  if (!tool) {
    return { intent: detected.intent, answer: FAILURE_MESSAGE_BY_INTENT[detected.intent] ?? UNSUPPORTED_ANSWER, actions: [] };
  }

  // its.get_driver_availability richiede sempre `date` (non opzionale nel
  // suo schema) — se l'utente non l'ha menzionata, default a oggi qui, non
  // nel parser (il parser resta un puro riconoscitore di testo).
  const input =
    detected.intent === "driver_availability" || detected.intent === "assignment_plan" || detected.intent === "assignment_exceptions"
      ? { date: detected.params.date ?? new Date().toISOString().slice(0, 10) }
      : detected.params;

  const rawResult = await runTool(context, tool, input);
  if (!isMcpToolContentResult(rawResult)) {
    return { intent: detected.intent, answer: FAILURE_MESSAGE_BY_INTENT[detected.intent] ?? UNSUPPORTED_ANSWER, actions: [] };
  }

  if (rawResult.isError) {
    return { intent: detected.intent, answer: FAILURE_MESSAGE_BY_INTENT[detected.intent] ?? UNSUPPORTED_ANSWER, actions: [] };
  }

  const text = rawResult.content[0]?.text;
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return { intent: detected.intent, answer: FAILURE_MESSAGE_BY_INTENT[detected.intent] ?? UNSUPPORTED_ANSWER, actions: [] };
  }

  switch (detected.intent) {
    case "operational_brief": {
      const { answer, actions } = formatOperationalBriefAnswer(parsed as OperationalBriefOutput);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    case "health_status": {
      const { answer, actions } = formatHealthStatusAnswer(parsed as HealthStatusOutput);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    case "alerts": {
      const { answer, actions } = formatAlertsAnswer(parsed as OperationalAlertsOutput);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    case "unassigned": {
      const { answer, actions } = formatUnassignedAnswer(parsed as UnassignedServicesOutput);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    case "driver_availability": {
      const { answer, actions } = formatDriverAvailabilityAnswer(parsed as DriverAvailabilityOutput, detected.params.timeWindow);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    case "assignment_plan": {
      const { answer, actions } = formatAssignmentPlanAnswer(parsed as AssignmentPlanOutput);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    case "assignment_exceptions": {
      const { answer, actions } = formatAssignmentExceptionsAnswer(parsed as AssignmentExceptionsOutput);
      return { intent: detected.intent, answer, actions, data: parsed };
    }
    default:
      return { intent: "unsupported", answer: UNSUPPORTED_ANSWER, actions: [] };
  }
}
