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
// FASE A — LLM router: attivo SOLO dietro MARIO_LLM_ENABLED (§27, default
// off). L'intent-parser deterministico sopra resta SEMPRE il fast-path/
// fallback (§14/§15): questi import intervengono solo per i messaggi che
// oggi il parser non sa gestire con sicurezza (unsupported/write_unsupported/
// booking_group_write).
import { isMarioLlmEnabled, isMarioLlmShadowMode } from "./llm-client";
import { buildMarioToolCatalog } from "./tool-catalog";
import { routeMarioWithLlm, type MarioRouterStepResult } from "./llm-router";
import { logMarioLlmRoute } from "./telemetry";
import {
  getMarioSession,
  updateMarioSession,
  clearPendingConfirmation,
  readPendingConfirmation,
  toMarioSessionSummary,
  getLastMarioSessionStore,
  type MarioSessionContext,
  type MarioPendingConfirmation,
} from "./session-context";

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

// ═══════════════════════════════════════════════════════════════════════
// FASE A — LLM Router: helper di orchestrazione.
//
// Attivi SOLO quando isMarioLlmEnabled() è vero, e SOLO per i tre intent che
// oggi il parser deterministico non sa gestire con sicurezza (unsupported /
// write_unsupported / booking_group_write). Ogni altro intent del parser
// (operational_brief, health_status, alerts, unassigned, driver_availability,
// assignment_plan, assignment_exceptions, booking_group_find/detail/inspect)
// resta il fast-path invariato più sotto — mai instradato all'LLM (§15,
// riduzione costi/latenza su richieste già affidabili).
// ═══════════════════════════════════════════════════════════════════════

/** Mappa preview -> execute: l'unica cosa che l'orchestratore esegue dopo
 *  conferma esplicita. L'LLM non vede mai questi tool WRITE (§11/§17): il
 *  catalogo (tool-catalog.ts) espone solo categoria READ. */
const PREVIEW_TO_EXECUTE_TOOL: Record<string, string> = {
  "its.preview_create_booking_group": "its.create_booking_group",
  "its.preview_add_booking_group_stop": "its.add_booking_group_stop",
  "its.preview_add_booking_group_passengers": "its.add_booking_group_passengers",
  "its.preview_reserve_booking_group_bus": "its.reserve_booking_group_bus",
  "its.preview_update_booking_group_ferry": "its.update_booking_group_ferry",
  "its.preview_booking_group_operationalization": "its.operationalize_booking_group",
  "its.preview_assign_driver": "its.assign_driver",
  "its.preview_update_service_status": "its.update_service_status",
};

// Letto ad ogni chiamata (non congelato al primo import del modulo): coerente
// con isMarioLlmEnabled()/isMarioLlmShadowMode(), che leggono l'env live cosi'
// il flag resta effettivo anche se cambiato senza riavviare il processo.
function getMaxLlmSteps(): number {
  return Math.max(1, Number(process.env.MARIO_LLM_MAX_STEPS ?? 3) || 3);
}

const YES_RE = /\b(s[iì]|confermo|conferma(to)?|ok(ay)?|va\s*bene|vai|procedi|fai\s*pure)\b/i;
const NO_RE = /\b(no|annulla|lascia\s*perdere|niente|stop|fermati|non\s*(farlo|procedere|confermo))\b/i;
// Una risposta di conferma e' sempre breve: oltre questa soglia trattiamo il
// messaggio come una richiesta nuova (evita falsi positivi su frasi lunghe
// che contengono per caso "no"/"ok" come parola).
const MAX_CONFIRMATION_REPLY_WORDS = 6;

/** §11/§12 — riconosce SOLO risposte brevi ed esplicite. Qualunque altro
 *  testo è "unclear": la conferma in sospeso decade (mai eseguita alla cieca
 *  su un messaggio ambiguo) e si torna al routing normale. */
function detectConfirmationReply(message: string): "yes" | "no" | "unclear" {
  const t = message.trim().toLowerCase();
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0 || wordCount > MAX_CONFIRMATION_REPLY_WORDS) return "unclear";
  if (YES_RE.test(t)) return "yes";
  if (NO_RE.test(t)) return "no";
  return "unclear";
}

/** §11 — "la risposta deve dire solo 'Confermi?'": qui una frase operativa
 *  minima (MAI un dump dei dati, MAI il token) seguita da "Confermi?". */
function buildConfirmationPrompt(toolName: string, output: Record<string, unknown>): string {
  switch (toolName) {
    case "its.preview_create_booking_group":
      return `Creo il gruppo «${output.name}» (${output.expected_pax} pax previsti${output.service_date_label ? `, ${output.service_date_label}` : ""}). Confermi?`;
    case "its.preview_add_booking_group_stop":
      return `Aggiungo la fermata ${output.city}${output.pickup_point ? ` — ${output.pickup_point}` : ""} (${output.expected_pax} pax) al gruppo «${output.group_name}». Confermi?`;
    case "its.preview_add_booking_group_passengers":
      return `Aggiungo ${output.passenger_count} nominativi (${output.total_pax} pax) al gruppo «${output.group_name}». Confermi?`;
    case "its.preview_reserve_booking_group_bus":
      return `Riservo ${output.bus_unit_label ?? "il bus"} per il gruppo «${output.group_name}» (${output.reserved_pax} pax${output.service_date_label ? `, ${output.service_date_label}` : ""}). Confermi?`;
    case "its.preview_update_booking_group_ferry":
      return `Aggiorno il traghetto del gruppo «${output.group_name}» (${(output.changes as unknown[] | undefined)?.length ?? 0} campi). Confermi?`;
    case "its.preview_booking_group_operationalization":
      return `Rendo operativi ${output.services_ready} servizi del gruppo «${output.group_name}». Confermi?`;
    case "its.preview_assign_driver": {
      const driver = output.driver as { name?: string } | undefined;
      const vehicle = output.vehicle as { label?: string } | null | undefined;
      return `Assegno ${driver?.name ?? "l'autista"} al servizio${vehicle?.label ? ` (mezzo ${vehicle.label})` : ""}. Confermi?`;
    }
    case "its.preview_update_service_status":
      return `Aggiorno lo stato del servizio a "${output.targetStatus}". Confermi?`;
    default:
      return "Confermi?";
  }
}

function confirmationErrorMessage(code: string | undefined): string {
  switch (code) {
    case "MCP_CONFIRMATION_EXPIRED":
      return "La conferma è scaduta, rifai la richiesta.";
    case "MCP_CONFIRMATION_ALREADY_USED":
      return "Questa operazione risulta già eseguita.";
    case "MCP_FORBIDDEN":
      return "Non hai i permessi per completare questa operazione.";
    default:
      return "Non sono riuscito a completare l'operazione. Riprova.";
  }
}

/** §10 — aggiorna il contesto breve dopo un tool READ (find/detail/preview),
 *  cosi' un follow-up ("aggiungi 20 a Tivoli") non richiede ridire il nome
 *  del gruppo. */
function deriveContextFromToolOutput(toolName: string, output: Record<string, unknown>): Partial<MarioSessionContext> {
  const patch: Partial<MarioSessionContext> = { lastIntent: toolName };
  if (toolName === "its.find_booking_group") {
    const matches = (output.matches as BgMatch[] | undefined) ?? [];
    if (matches.length === 1) {
      patch.lastBookingGroupId = matches[0]!.id;
      patch.lastBookingGroupName = matches[0]!.name;
    }
  }
  if (toolName === "its.get_booking_group_detail" || toolName === "its.preview_booking_group_operationalization") {
    if (typeof output.booking_group_id === "string") patch.lastBookingGroupId = output.booking_group_id;
    if (typeof output.group_name === "string") patch.lastBookingGroupName = output.group_name;
  }
  if (toolName === "its.preview_create_booking_group" && typeof output.name === "string") {
    patch.lastBookingGroupName = output.name;
  }
  if (toolName === "its.preview_add_booking_group_stop" && typeof output.city === "string") {
    patch.lastStopCity = output.city;
  }
  return patch;
}

/** §10 — dopo una scrittura confermata, il nuovo id/nome diventa "ultimo
 *  gruppo": una creazione seguita da "aggiungi 20 a Tivoli" non richiede una
 *  nuova find_booking_group. */
function deriveContextFromWriteOutput(executeToolName: string, output: Record<string, unknown>): Partial<MarioSessionContext> {
  if (executeToolName === "its.create_booking_group" && typeof output.bookingGroupId === "string") {
    return {
      lastBookingGroupId: output.bookingGroupId,
      lastBookingGroupName: typeof output.name === "string" ? output.name : undefined,
    };
  }
  if (executeToolName === "its.add_booking_group_stop" && typeof output.bookingGroupId === "string") {
    return {
      lastBookingGroupId: output.bookingGroupId,
      lastStopCity: typeof output.city === "string" ? output.city : undefined,
    };
  }
  return {};
}

/** Riassunto compatto (cost control §16) del risultato di un tool READ, usato
 *  SOLO per continuare il loop multi-step (§8) — mai il payload intero. */
function summarizeForContext(toolName: string, output: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "its.find_booking_group") {
    return { ambiguous: output.ambiguous, count: output.count, matches: (output.matches as BgMatch[] | undefined)?.slice(0, 5) };
  }
  return { ok: true };
}

/** Formattazione generica best-effort per i tool READ non gia' coperti da un
 *  caso specifico (§21/§23): mai inventa dati, riporta solo campi scalari
 *  gia' presenti nell'output del tool. */
function summarizeReadToolAnswer(toolName: string, output: Record<string, unknown>): string {
  if (toolName === "its.get_booking_group_detail") {
    const group = output.group as { name?: string; expected_pax?: number } | undefined;
    const summary = (output.summary as { pax?: Record<string, number> } | undefined)?.pax ?? {};
    const stops = (output.stops as unknown[] | undefined)?.length ?? 0;
    const services = (output.services as unknown[] | undefined)?.length ?? 0;
    return (
      `Gruppo «${group?.name ?? "?"}» — ${summary.expectedPax ?? group?.expected_pax ?? "?"} pax previsti, ` +
      `${summary.plannedPax ?? 0} pianificati sulle fermate (${stops}), ${summary.servicePax ?? 0} già in servizi (${services}). ` +
      `Gap servizi: ${summary.remainingServicePax ?? "-"}.`
    );
  }
  if (toolName === "its.preview_booking_group_operationalization") {
    const ready = Number(output.services_ready ?? 0);
    const blocked = Number(output.services_blocked ?? 0);
    const already = Number(output.services_already_operational ?? 0);
    const warnings = (output.warnings as string[] | undefined) ?? [];
    const parts = [`Gruppo «${output.group_name ?? "?"}»: ${ready} servizi pronti, ${blocked} bloccati, ${already} già operativi.`];
    if (warnings.length) parts.push(`Attenzione: ${warnings.join(", ")}.`);
    return parts.join(" ");
  }
  if (toolName === "its.preview_assign_driver" || toolName === "its.preview_update_service_status") {
    const conflicts = (output.conflicts as Array<{ message: string }> | undefined) ?? [];
    if (conflicts.length) return `Non posso procedere: ${conflicts.map((c) => c.message).join("; ")}.`;
    return "Al momento non risulta possibile completare questa operazione.";
  }
  const scalarEntries = Object.entries(output).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  if (scalarEntries.length === 0) return "Ecco il risultato della ricerca.";
  return scalarEntries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

function bgActionsIfRelevant(toolName: string): Array<{ label: string; href: string }> {
  return toolName.includes("booking_group") ? BG_ACTIONS : [];
}

/** §11/§12 — l'utente ha risposto "sì"/"no" a una conferma in sospeso. Il
 *  token non viene mai ricostruito dal router LLM: resta quello emesso dalla
 *  preview, consumato qui in un solo colpo (§13 — nessun cambio all'HMAC/TTL/
 *  single-use/binding esistenti). */
async function executeConfirmedWrite(context: McpContext, pending: MarioPendingConfirmation): Promise<MarioAssistantResult> {
  await clearPendingConfirmation(context.tenantId, context.userId);

  const tool = getTool(pending.toolName);
  if (!tool) {
    return { intent: "mario_llm_confirmation_error", answer: "Non riesco più a completare questa operazione: prova a rifare la richiesta.", actions: [] };
  }

  const raw = await runTool(context, tool, { confirmationToken: pending.confirmationToken });
  if (!isMcpToolContentResult(raw) || raw.isError) {
    let code: string | undefined;
    if (isMcpToolContentResult(raw)) {
      const text = raw.content[0]?.text;
      try {
        code = text ? (JSON.parse(text) as { code?: string }).code : undefined;
      } catch {
        code = undefined;
      }
    }
    return { intent: "mario_llm_confirmation_error", answer: confirmationErrorMessage(code), actions: [] };
  }

  const text = raw.content[0]?.text;
  let output: Record<string, unknown> = {};
  try {
    output = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    output = {};
  }

  await updateMarioSession(context.tenantId, context.userId, deriveContextFromWriteOutput(pending.toolName, output));
  return { intent: "mario_llm_confirmed", answer: "Fatto. Operazione completata.", actions: BG_ACTIONS, data: output };
}

/** Fallback statico invariato: stesso identico testo/percorso di oggi quando
 *  MARIO_LLM_ENABLED e' spento, e stesso percorso anche quando l'LLM fallisce
 *  a runtime (§14) — nessuna seconda copia del messaggio "gruppo prenotazione". */
async function staticFallbackAnswer(context: McpContext, detected: MarioIntentResult): Promise<MarioAssistantResult> {
  if (detected.intent === "write_unsupported") {
    return { intent: "write_unsupported", answer: WRITE_UNSUPPORTED_ANSWER, actions: [] };
  }
  if (detected.intent === "booking_group_write") {
    return runBookingGroupIntent(context, detected as Extract<MarioIntentResult, { intent: `booking_group_${string}` }>);
  }
  return { intent: "unsupported", answer: UNSUPPORTED_ANSWER, actions: [] };
}

/** true se il contesto breve porta almeno un riferimento utile per un
 *  follow-up (gruppo/fermata/data/intent). Solo per la telemetria §17
 *  (context_loaded) — non decide nulla di funzionale. */
function hasSessionContext(ctx: MarioSessionContext): boolean {
  return Boolean(
    ctx.lastBookingGroupId ||
      ctx.lastBookingGroupName ||
      ctx.lastBookingGroupStopId ||
      ctx.lastStopCity ||
      ctx.lastDate ||
      ctx.lastIntent,
  );
}

/** Ciclo limitato (§8/§16, MAX_LLM_STEPS passi): il router puo' incatenare
 *  SOLO tool READ senza token (es. find_booking_group -> preview_*). Appena
 *  un risultato porta un confirmationToken, il ciclo si ferma e si passa alla
 *  conferma esplicita — mai due scritture non confermate nello stesso turno
 *  (§20). */
async function runMarioLlmFlow(context: McpContext, message: string, detected: MarioIntentResult): Promise<MarioAssistantResult> {
  const catalog = buildMarioToolCatalog(context);
  const priorSteps: MarioRouterStepResult[] = [];
  const maxSteps = getMaxLlmSteps();

  for (let step = 0; step < maxSteps; step += 1) {
    // Rilettura ad ogni giro: dopo un updateMarioSession() (sotto) il contesto
    // condiviso può essere cambiato; su serverless il turno può anche essere
    // servito da un'istanza diversa da quella del turno precedente (§A.1).
    const sessionCtx = await getMarioSession(context.tenantId, context.userId);
    const routed = await routeMarioWithLlm({
      message,
      role: context.role,
      sessionSummary: toMarioSessionSummary(sessionCtx),
      toolCatalog: catalog,
      priorSteps,
    });

    logMarioLlmRoute({
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      step,
      decision: routed.decision,
      usage: routed.usage,
      fallbackUsed: routed.fallbackUsed,
      fallbackReason: routed.fallbackReason,
      latencyMs: routed.latencyMs,
      sessionStore: getLastMarioSessionStore(),
      contextLoaded: hasSessionContext(sessionCtx),
      pendingConfirmation: Boolean(sessionCtx.pendingConfirmation),
    });

    if (routed.fallbackUsed || routed.decision.action === "fallback") {
      return staticFallbackAnswer(context, detected);
    }

    if (routed.decision.action === "clarification") {
      await updateMarioSession(context.tenantId, context.userId, { lastIntent: "mario_llm_clarification" });
      return { intent: "mario_llm_clarification", answer: routed.decision.clarification_question, actions: [] };
    }

    if (routed.decision.action === "answer") {
      return { intent: "mario_llm_answer", answer: routed.decision.answer, actions: [] };
    }

    // action === "tool_call"
    const toolName = routed.decision.tool_name;
    const tool = getTool(toolName);
    if (!tool) return staticFallbackAnswer(context, detected);

    // §19 — difesa in profondità: un token eventualmente "suggerito"
    // dal modello nei suoi argomenti viene sempre ignorato. Il router LLM
    // non possiede mai un confirmationToken reale.
    const { confirmationToken: _ignoredHallucinatedToken, ...safeArguments } = (routed.decision.arguments ?? {}) as Record<string, unknown>;

    const raw = await runTool(context, tool, safeArguments);
    if (!isMcpToolContentResult(raw) || raw.isError) {
      return { intent: "mario_llm_tool_error", answer: "Al momento non riesco a completare questa richiesta. Riprova o specifica meglio.", actions: [] };
    }

    const text = raw.content[0]?.text;
    let output: Record<string, unknown>;
    try {
      output = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return staticFallbackAnswer(context, detected);
    }

    const token = typeof output.confirmationToken === "string" ? output.confirmationToken : null;
    if (token) {
      const executeTool = PREVIEW_TO_EXECUTE_TOOL[toolName];
      if (!executeTool) return staticFallbackAnswer(context, detected); // difesa: preview senza execute mappato

      await updateMarioSession(context.tenantId, context.userId, {
        ...deriveContextFromToolOutput(toolName, output),
        pendingConfirmation: { toolName: executeTool, confirmationToken: token, op: toolName, createdAt: Date.now() },
      });

      return { intent: "mario_llm_pending_confirmation", answer: buildConfirmationPrompt(toolName, output), actions: bgActionsIfRelevant(toolName) };
    }

    await updateMarioSession(context.tenantId, context.userId, deriveContextFromToolOutput(toolName, output));

    if (toolName === "its.find_booking_group") {
      const matches = (output.matches as BgMatch[] | undefined) ?? [];
      if (matches.length === 0) {
        return { intent: "mario_llm_answer", answer: "Nessun gruppo prenotazione trovato.", actions: BG_ACTIONS };
      }
      if (output.ambiguous || matches.length > 1) {
        return { intent: "mario_llm_clarification", answer: `Ci sono più gruppi che corrispondono. Quale intendi?\n${listGroupsText(matches)}`, actions: BG_ACTIONS, data: { matches } };
      }
      // Match unico: il prossimo giro del loop ha lastBookingGroupId/nome in
      // contesto e puo' proseguire (es. preview_add_booking_group_stop).
      priorSteps.push({ toolName, resultSummary: summarizeForContext(toolName, output) });
      continue;
    }

    return {
      intent: `mario_llm_tool:${toolName}`,
      answer: summarizeReadToolAnswer(toolName, output),
      actions: bgActionsIfRelevant(toolName),
      data: output,
    };
  }

  return staticFallbackAnswer(context, detected);
}

/** §28 — shadow mode opzionale: osserva la decisione del router SENZA
 *  guidare la risposta (che resta quella statica di oggi). Utile per
 *  confrontare prima di attivare MARIO_LLM_ENABLED in produzione. Nessuna
 *  eccezione puo' uscire da qui: e' puro logging diagnostico. */
async function runMarioLlmShadow(context: McpContext, message: string): Promise<void> {
  try {
    const sessionCtx = await getMarioSession(context.tenantId, context.userId);
    const catalog = buildMarioToolCatalog(context);
    const routed = await routeMarioWithLlm({
      message,
      role: context.role,
      sessionSummary: toMarioSessionSummary(sessionCtx),
      toolCatalog: catalog,
    });
    logMarioLlmRoute({
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      step: 0,
      decision: routed.decision,
      usage: routed.usage,
      fallbackUsed: routed.fallbackUsed,
      fallbackReason: routed.fallbackReason,
      latencyMs: routed.latencyMs,
      sessionStore: getLastMarioSessionStore(),
      contextLoaded: hasSessionContext(sessionCtx),
      pendingConfirmation: Boolean(sessionCtx.pendingConfirmation),
      shadow: true,
    });
  } catch {
    // Shadow mode e' diagnostico: un suo fallimento non deve mai propagarsi.
  }
}

export async function runMarioAssistant(
  context: McpContext,
  message: string,
  now: Date = new Date()
): Promise<MarioAssistantResult> {
  // §11/§12 — una conferma in sospeso ha priorità su qualunque altro routing:
  // se l'utente risponde sì/no, si esegue/annulla, punto. Qualunque altro
  // messaggio fa decadere la conferma (mai eseguita alla cieca su un turno
  // che è andato altrove) e prosegue con il routing normale sotto.
  const pending = await readPendingConfirmation(context.tenantId, context.userId);
  if (pending.status === "valid") {
    const reply = detectConfirmationReply(message);
    if (reply === "yes") {
      return executeConfirmedWrite(context, pending.pending);
    }
    if (reply === "no") {
      await clearPendingConfirmation(context.tenantId, context.userId);
      return { intent: "confirmation_cancelled", answer: "Ok, annullato. Nessuna modifica è stata applicata.", actions: [] };
    }
    await clearPendingConfirmation(context.tenantId, context.userId);
  } else if (pending.status === "expired") {
    // §13 — la sessione può vivere 10 min, ma una conferma oltre i 180s del
    // TTL HMAC è logicamente morta: mai eseguire il WRITE su un "confermo"
    // tardivo, e dirlo chiaramente.
    await clearPendingConfirmation(context.tenantId, context.userId);
    if (detectConfirmationReply(message) === "yes") {
      return {
        intent: "confirmation_expired",
        answer: "Quella conferma è scaduta, devo preparare una nuova anteprima.",
        actions: [],
      };
    }
  }

  const detected = detectMarioIntent(message, now);
  const llmEnabled = isMarioLlmEnabled();
  const shadowMode = isMarioLlmShadowMode();

  if (detected.intent === "unsupported" || detected.intent === "write_unsupported") {
    if (llmEnabled) return runMarioLlmFlow(context, message, detected);
    if (shadowMode) await runMarioLlmShadow(context, message);
    return detected.intent === "unsupported"
      ? { intent: "unsupported", answer: UNSUPPORTED_ANSWER, actions: [] }
      : { intent: "write_unsupported", answer: WRITE_UNSUPPORTED_ANSWER, actions: [] };
  }

  // FASE 3 — gruppi prenotazione: READ via tool MCP, WRITE indirizzata al
  // flusso anteprima → conferma (stessa pipeline runTool, nessun secondo motore).
  if (detected.intent.startsWith("booking_group_")) {
    if (detected.intent === "booking_group_write") {
      if (llmEnabled) return runMarioLlmFlow(context, message, detected);
      if (shadowMode) await runMarioLlmShadow(context, message);
    }
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
