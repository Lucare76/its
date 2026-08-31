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
import { detectMarioIntent, extractBookingGroupQuery, UNSUPPORTED_ANSWER, WRITE_UNSUPPORTED_ANSWER, type MarioIntentResult } from "./intent-parser";
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
import { isMarioLlmEnabled, isMarioLlmShadowMode, getMarioLlmModel } from "./llm-client";
import { buildMarioToolCatalog } from "./tool-catalog";
import { routeMarioWithLlm, type MarioRouterStepResult } from "./llm-router";
import { logMarioLlmRoute, logMarioDraftPersistence } from "./telemetry";
import { calcMarioLlmCost } from "./pricing";
import { parseMarioDraftDateSlots, formatMarioDateForUser } from "./date-time";
import { BOOKING_GROUP_KINDS } from "@/lib/booking-groups";
import {
  MARIO_OPERATION_POLICIES,
  classifyMarioOperation,
  evaluateMarioOperationPolicy,
  buildMcpArguments,
  questionForMissingField,
  mentionsPhysicalBus,
  BLOCKING_PREVIEW_WARNINGS,
  extractMarioDraftSlotsFromMessage,
  sanitizeExpectedPax,
  type MarioOperationKey,
} from "./operation-policy";
import {
  getMarioSession,
  updateMarioSession,
  clearPendingConfirmation,
  readPendingConfirmation,
  readMarioDraftOperation,
  setMarioDraftOperation,
  clearMarioDraftOperation,
  toMarioSessionSummary,
  getLastMarioSessionStore,
  type MarioSessionContext,
  type MarioPendingConfirmation,
  type MarioDraftOperation,
  type MarioDraftSlots,
} from "./session-context";

export type MarioAssistantResult = {
  intent: string;
  answer: string;
  actions: Array<{ label: string; href: string }>;
  data?: unknown;
  /** FASE A.2 — costo/uso LLM di QUESTO turno (somma delle chiamate del loop
   *  multi-step). Assente = nessuna chiamata LLM (fast-path deterministico o
   *  conferma): la UI lo tratta come costo 0 / nessuna "chiamata AI". */
  llm?: MarioTurnLlmUsage;
};

export type MarioTurnLlmUsage = {
  llmCalled: boolean;
  calls: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** null = tariffe non configurate: la UI mostra i token, non un costo. */
  costUsd: number | null;
  fallbackUsed: boolean;
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

type BgMatch = { id: string; name: string; expected_pax: number; status: string; service_date: string | null; service_date_label: string | null };

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
    .map((m) => {
      // FIX A.4.4 §10 — sempre DD-MM-YYYY all'utente, mai lo slash del
      // formatter ITS condiviso (fmtDateIt): Mario usa la propria data
      // canonica ISO (`service_date`) e la propria formattazione.
      const dateLabel = formatMarioDateForUser(m.service_date);
      return `• ${m.name} — ${m.expected_pax} pax, stato ${m.status}${dateLabel ? `, ${dateLabel}` : ""}`;
    })
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
      answer: `Gruppo «${g.name}»: ${g.expected_pax} pax previsti, stato ${g.status}${formatMarioDateForUser(g.service_date) ? `, data ${formatMarioDateForUser(g.service_date)}` : ""}.`,
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

// Confine di "parola" robusto agli accenti: `\b` non funziona dopo 'ì' (non è
// \w), quindi "sì" non veniva riconosciuto. Lookaround su \p{L} (flag u).
const YES_RE = /(?<!\p{L})(s[iì]|confermo|conferma(?:to)?|ok(?:ay)?|va\s*bene|vai|procedi|fai\s*pure|d['’ ]?accordo|certo)(?!\p{L})/iu;
const NO_RE = /(?<!\p{L})(no|annulla(?:re)?|lascia\s*(?:perdere|stare)|niente|stop|fermati|non\s*(?:farlo|procedere|confermo))(?!\p{L})/iu;
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
    case "its.preview_create_booking_group": {
      // FIX A.4.4 §10 — DD-MM-YYYY dalla data canonica ISO, mai lo slash di
      // `service_date_label` (formatter ITS condiviso, non Mario-specifico).
      const dateLabel = formatMarioDateForUser(output.service_date as string | null | undefined);
      return `Creo il gruppo «${output.name}» (${output.expected_pax} pax previsti${dateLabel ? `, ${dateLabel}` : ""}). Confermi?`;
    }
    case "its.preview_add_booking_group_stop":
      return `Aggiungo la fermata ${output.city}${output.pickup_point ? ` — ${output.pickup_point}` : ""} (${output.expected_pax} pax) al gruppo «${output.group_name}». Confermi?`;
    case "its.preview_add_booking_group_passengers":
      return `Aggiungo ${output.passenger_count} nominativi (${output.total_pax} pax) al gruppo «${output.group_name}». Confermi?`;
    case "its.preview_reserve_booking_group_bus": {
      const dateLabel = formatMarioDateForUser(output.service_date as string | null | undefined);
      return `Riservo ${output.bus_unit_label ?? "il bus"} per il gruppo «${output.group_name}» (${output.reserved_pax} pax${dateLabel ? `, ${dateLabel}` : ""}). Confermi?`;
    }
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
  // §9 — operazione completata e confermata: il draft non serve più.
  await clearMarioDraftOperation(context.tenantId, context.userId);
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

/** Accumulatore uso LLM del turno (§7/§16): mutato in un SOLO punto (dopo
 *  ogni routeMarioWithLlm), letto in un SOLO punto (runMarioAssistant, dove
 *  attacca `.llm` alla risposta). Le chiamate del loop multi-step si sommano. */
type TurnLlmAcc = { calls: number; inputTokens: number; outputTokens: number; fallbackUsed: boolean };
function newTurnLlmAcc(): TurnLlmAcc {
  return { calls: 0, inputTokens: 0, outputTokens: 0, fallbackUsed: false };
}
const ATTEMPTED_FAILURE_REASONS = new Set(["timeout", "network_error", "http_error", "empty_response", "unknown_error"]);
function accumulateTurnLlm(acc: TurnLlmAcc, routed: Awaited<ReturnType<typeof routeMarioWithLlm>>): void {
  const attemptedButFailed = routed.usage == null && routed.fallbackReason != null && ATTEMPTED_FAILURE_REASONS.has(routed.fallbackReason);
  if (routed.usage != null || attemptedButFailed) acc.calls += 1;
  acc.inputTokens += routed.usage?.inputTokens ?? 0;
  acc.outputTokens += routed.usage?.outputTokens ?? 0;
  if (routed.fallbackUsed) acc.fallbackUsed = true;
}
function finalizeTurnLlm(acc: TurnLlmAcc): MarioTurnLlmUsage {
  const model = getMarioLlmModel();
  const cost = calcMarioLlmCost(model, acc.inputTokens, acc.outputTokens);
  return {
    llmCalled: true,
    calls: acc.calls,
    model,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    costUsd: cost ? cost.totalCostUsd : null,
    fallbackUsed: acc.fallbackUsed,
  };
}

/** Esegue un turno che passa dal router LLM e attacca alla risposta il
 *  riepilogo costi del turno (§14). Se nessuna chiamata LLM è avvenuta
 *  (es. no_api_key), `.llm` resta assente → la UI lo tratta come costo 0. */
async function runLlmTurn(context: McpContext, message: string, detected: MarioIntentResult, now: Date): Promise<MarioAssistantResult> {
  const acc = newTurnLlmAcc();
  const result = await runMarioLlmFlow(context, message, detected, acc, now);
  return acc.calls > 0 ? { ...result, llm: finalizeTurnLlm(acc) } : result;
}

// ═══════════════════════════════════════════════════════════════════════════
// FASE A.3 — slot filling: draft operativo multi-turno.
// ═══════════════════════════════════════════════════════════════════════════

/** Intent (deterministici) che, con un draft attivo, vanno dirottati al flusso
 *  draft-aware invece di ripartire da zero o finire in find_booking_group.
 *  Gli intent READ chiari (operational_brief, ecc.) NON sono qui: restano sul
 *  fast-path deterministico anche a draft attivo (§7/§17). */
const DRAFT_DIVERT_INTENTS = new Set(["unsupported", "write_unsupported", "booking_group_find", "booking_group_write"]);

// §8 — reset del draft. Nessuna frase hardcoded specifica: verbi generici.
const DRAFT_RESET_RE = /(?<!\p{L})(annulla(?:re)?|lascia\s*(?:stare|perdere)|ricomincia\w*|dimentica(?:re)?\s+(?:questa|l['’ ]?operazione)?|azzera|reset)(?!\p{L})/iu;
function isDraftReset(message: string): boolean {
  const t = message.trim().toLowerCase();
  return t.split(/\s+/).filter(Boolean).length <= 6 && DRAFT_RESET_RE.test(t);
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

/** Estrae gli slot del gruppo dagli arguments del router. `origin`/`pickupPoint`
 *  vengono conservati NEL DRAFT (§6/§33) ma il tool argument builder li scarta
 *  perché non sono campi di its.preview_create_booking_group. */
function slotsFromCreateArgs(args: Record<string, unknown>): MarioDraftSlots {
  const out: MarioDraftSlots = {};
  if (typeof args.name === "string" && args.name.trim()) out.name = args.name.trim();
  if (typeof args.expectedPax === "number" && Number.isFinite(args.expectedPax)) out.expectedPax = args.expectedPax;
  if (typeof args.serviceDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.serviceDate)) out.serviceDate = args.serviceDate;
  if (typeof args.kind === "string" && (BOOKING_GROUP_KINDS as readonly string[]).includes(args.kind)) out.kind = args.kind;
  if (typeof args.origin === "string" && args.origin.trim()) out.origin = args.origin.trim();
  if (typeof args.pickupPoint === "string" && args.pickupPoint.trim()) out.pickupPoint = args.pickupPoint.trim();
  for (const f of ["agency", "hotel", "contact", "notes", "contactName", "contactPhone"]) {
    if (typeof args[f] === "string" && (args[f] as string).trim()) (out as Record<string, unknown>)[f] = (args[f] as string).trim();
  }
  return out;
}

/** La chiave operazione del draft, ricondotta a MarioOperationKey via policy. */
function draftOperationKey(draft: MarioDraftOperation): MarioOperationKey {
  return classifyMarioOperation({ rawType: draft.type, kind: draft.collected.kind });
}

/** §17/§28/§41 — fast-path deterministico: se il messaggio contiene una data
 *  affidabile e ciò basta (secondo la POLICY) a rendere il draft pronto per la
 *  preview, la riempie SENZA chiamare l'LLM. Ritorna { operation, slots } o
 *  null se non applicabile. Solo per le operazioni di creazione gruppo (le
 *  altre hanno slot che richiedono NLU). */
function tryDeterministicDraftFill(
  draft: MarioDraftOperation,
  message: string,
  now: Date,
): { operation: MarioOperationKey; slots: MarioDraftSlots } | null {
  const operation = draftOperationKey(draft);
  if (operation !== "create_generic_booking_group" && operation !== "create_bus_group" && operation !== "create_exclusive_bus_group") {
    return null;
  }
  // Il fast-path scatta SOLO se il messaggio porta una DATA affidabile: è
  // l'unico slot risolvibile senza NLU. Un messaggio senza data ("anzi 45",
  // "La Marra", un nome) va al router — è una correzione, non un
  // completamento deterministico.
  // FIX A.4.5 §8 — anche un INTERVALLO esplicito ("dal 13 al 20 settembre")
  // completa il draft deterministicamente: serviceDate = inizio, returnDate
  // (draft-only, mai inviato al tool §5) = fine.
  const dateSlots = parseMarioDraftDateSlots(message, now);
  if (!dateSlots) return null;
  const candidate: MarioDraftSlots = { ...draft.collected, ...dateSlots };
  const evalR = evaluateMarioOperationPolicy({ operation, collected: candidate });
  return evalR.readyForPreview ? { operation, slots: candidate } : null;
}

/** Esegue direttamente il tool "preview_" dell'operazione dagli slot del draft,
 *  SENZA chiamata LLM (§17/§28). `buildMcpArguments` scarta i campi non
 *  supportati dallo schema (mai `origin`, §6). Stessa pipeline runTool / stesso
 *  pending confirmation / stesso testo "Confermi?" del flusso normale. */
async function runDraftDirectPreview(
  context: McpContext,
  operation: MarioOperationKey,
  slots: MarioDraftSlots,
): Promise<MarioAssistantResult> {
  const previewToolName = MARIO_OPERATION_POLICIES[operation].mcpTool;
  const tool = getTool(previewToolName);
  if (!tool) return { intent: "mario_llm_tool_error", answer: "Non riesco a preparare l'operazione adesso. Riprova.", actions: [] };

  const args = buildMcpArguments(operation, slots as Record<string, unknown>);
  const raw = await runTool(context, tool, args);
  if (!isMcpToolContentResult(raw) || raw.isError) {
    return { intent: "mario_llm_tool_error", answer: "Non riesco a completare l'operazione. Riprova o specifica meglio.", actions: [] };
  }
  let output: Record<string, unknown> = {};
  try {
    output = raw.content[0]?.text ? (JSON.parse(raw.content[0]!.text!) as Record<string, unknown>) : {};
  } catch {
    return { intent: "mario_llm_tool_error", answer: "Non riesco a completare l'operazione. Riprova o specifica meglio.", actions: [] };
  }
  const token = typeof output.confirmationToken === "string" ? output.confirmationToken : null;
  if (!token) return { intent: "mario_llm_tool_error", answer: "Non riesco a completare l'operazione. Riprova o specifica meglio.", actions: [] };

  const executeTool = PREVIEW_TO_EXECUTE_TOOL[previewToolName];
  await updateMarioSession(context.tenantId, context.userId, {
    ...deriveContextFromToolOutput(previewToolName, output),
    draftOperation: { type: operation, collected: slots, missing: [], updatedAt: Date.now() },
    pendingConfirmation: {
      toolName: executeTool ?? "its.create_booking_group",
      confirmationToken: token,
      op: previewToolName,
      createdAt: Date.now(),
    },
  });
  return {
    intent: "mario_llm_pending_confirmation",
    answer: buildConfirmationPrompt(previewToolName, output),
    actions: bgActionsIfRelevant(previewToolName),
  };
}

/** Turno con draft attivo: prova il fast-path deterministico (§17), altrimenti
 *  passa al router con il draft nel contesto. */
async function runDraftTurn(context: McpContext, message: string, draft: MarioDraftOperation, now: Date): Promise<MarioAssistantResult> {
  const fast = tryDeterministicDraftFill(draft, message, now);
  if (fast) return runDraftDirectPreview(context, fast.operation, fast.slots); // nessuna chiamata LLM
  return runLlmTurn(context, message, { intent: "booking_group_write", params: {} }, now);
}

type CreateGateResult =
  | { proceed: false; result: MarioAssistantResult }
  | { proceed: true; operation: MarioOperationKey; mergedSlots: MarioDraftSlots; toolArgs: Record<string, unknown> }
  | { proceed: "passthrough" };

/**
 * FASE A.4 §5/§27/§28/§30 — gate deterministico prima di eseguire la preview di
 * CREAZIONE gruppo. Classifica l'operazione (bus / bus esclusivo / generico) e
 * verifica i campi OPERATIVI via policy. Se non pronta → salva draft con
 * `missing` autoritativo + clarification mirata. Se pronta → ritorna gli
 * arguments RICOSTRUITI dal builder deterministico (mai `origin` o campi
 * illegali) e gli slot da salvare nel draft. Nessuna seconda chiamata LLM.
 */
async function applyCreatePreviewPolicyGate(
  context: McpContext,
  toolName: string,
  args: Record<string, unknown>,
  message: string,
  now: Date,
): Promise<CreateGateResult> {
  if (toolName !== "its.preview_create_booking_group") return { proceed: "passthrough" };

  // §11/§37 — ambiguità "bus": se il messaggio indica un MEZZO FISICO
  // (posti/targa/capacità), NON creare automaticamente un gruppo da quella
  // capienza: chiedi cosa vuole davvero.
  if (mentionsPhysicalBus(message)) {
    return {
      proceed: false,
      result: {
        intent: "mario_llm_clarification",
        answer: "Vuoi creare il gruppo bus (prenotazione commerciale) o riservare un mezzo fisico per il gruppo?",
        actions: [],
      },
    };
  }

  const existingDraft = await readMarioDraftOperation(context.tenantId, context.userId);
  const merged: MarioDraftSlots = { ...(existingDraft?.collected ?? {}), ...slotsFromCreateArgs(args) };
  // FIX A.4.4 §5/§6/§16/§17 — una data ESPLICITA nel messaggio corrente vince
  // SEMPRE: sul draft esistente (possibile sessione stale) e su un
  // `serviceDate` proposto dal router LLM (arguments.serviceDate) — mai il
  // contrario. Seconda rete di sicurezza deterministica anche se l'LLM ha
  // comunque tentato di reinterpretare/allucinare la data.
  // FIX A.4.5 §4/§5 — anche un intervallo esplicito ("dal 13 al 20 settembre")
  // vince qui: serviceDate = inizio, returnDate = fine (draft-only, §5).
  const explicitDateSlots = parseMarioDraftDateSlots(message, now);
  if (explicitDateSlots) Object.assign(merged, explicitDateSlots);
  const operation = classifyMarioOperation({ toolName, kind: merged.kind, message });
  const evalR = evaluateMarioOperationPolicy({ operation, collected: merged as Record<string, unknown> });

  if (!evalR.readyForPreview) {
    await setMarioDraftOperation(context.tenantId, context.userId, {
      type: operation,
      collected: merged,
      missing: evalR.missingRequired,
    });
    return { proceed: false, result: { intent: "mario_llm_clarification", answer: questionForMissingField(evalR.nextQuestionField), actions: [] } };
  }

  return { proceed: true, operation, mergedSlots: merged, toolArgs: buildMcpArguments(operation, merged as Record<string, unknown>) };
}

/** §36 — testo per il warning pax fermate > totale gruppo. */
function paxOverbookedQuestion(toolName: string, output: Record<string, unknown>): string {
  if (toolName === "its.preview_add_booking_group_stop") {
    const after = output.planned_pax_after ?? "?";
    const total = output.group_expected_pax ?? "?";
    return `Con questa fermata i pax pianificati salgono a ${after}, oltre i ${total} previsti per il gruppo. Vuoi alzare il totale del gruppo o correggere i pax della fermata?`;
  }
  return "Questa operazione supererebbe i pax previsti. Vuoi correggere?";
}

/**
 * FIX A.4.2 §2/§4/§12 — riconosce, SENZA regex per-frase, se una clarification
 * priva di `operation` riguarda comunque un'operazione OPERATIVA in corso (che
 * quindi NON può restare solo testo/`lastIntent`, pena la perdita del
 * contesto al turno successivo — bug live confermato). Riusa solo segnali
 * deterministici già esistenti:
 *  - un draft già aperto (continuazione/correzione) è sempre operativo;
 *  - `detectMarioIntent` ha già riconosciuto un WRITE di gruppo;
 *  - `classifyMarioOperation` (categorie bus/esclusivo di operation-policy.ts,
 *    non frasi) si scosta dal default generico.
 * Una clarification puramente informativa (nessuno di questi segnali) resta
 * senza draft — principio §2 del fix.
 */
function isOperativeClarificationContext(message: string, existingDraft: MarioDraftOperation | null, detected: MarioIntentResult): boolean {
  if (existingDraft) return true;
  if (detected.intent === "booking_group_write") return true;
  return classifyMarioOperation({ message }) !== "create_generic_booking_group";
}

/** Ciclo limitato (§8/§16, MAX_LLM_STEPS passi): il router puo' incatenare
 *  SOLO tool READ senza token (es. find_booking_group -> preview_*). Appena
 *  un risultato porta un confirmationToken, il ciclo si ferma e si passa alla
 *  conferma esplicita — mai due scritture non confermate nello stesso turno
 *  (§20). */
async function runMarioLlmFlow(
  context: McpContext,
  message: string,
  detected: MarioIntentResult,
  turnLlm: TurnLlmAcc,
  now: Date,
): Promise<MarioAssistantResult> {
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
    accumulateTurnLlm(turnLlm, routed);

    logMarioLlmRoute({
      tenantId: context.tenantId,
      userId: context.userId,
      requestId: context.requestId,
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
      schemaIssuePaths: routed.schemaIssues?.paths,
      schemaIssueCodes: routed.schemaIssues?.codes,
    });

    if (routed.fallbackUsed || routed.decision.action === "fallback") {
      return staticFallbackAnswer(context, detected);
    }

    if (routed.decision.action === "clarification") {
      const op = routed.decision.operation;
      const existing = await readMarioDraftOperation(context.tenantId, context.userId);
      const draftPresentBefore = Boolean(existing);
      let draftSavedAfter = false;
      let draftOperationType: string | undefined;
      let draftMissingFields: string[] | undefined;
      let reason: "operation_from_router" | "operation_reconstructed" | "non_operative_clarification";

      if (op) {
        // FASE A.3 §3/§4 — slot filling. FASE A.4 §25/§27 — `missing` NON è
        // deciso dal modello: si ricalcola con la policy deterministica dopo il
        // merge (l'LLM estrae slot, la policy decide cosa è obbligatorio).
        const merged = { ...(existing?.collected ?? {}), ...pruneUndefined(op.collected) };
        // FIX A.4.5 §3 — seconda rete di sicurezza sul tipo di expectedPax nel
        // MERGE (oltre alla coercizione nell'envelope in llm-router.ts): mai
        // un valore non-numero/non-finito/non-positivo nel draft.
        if (merged.expectedPax !== undefined) {
          const clean = sanitizeExpectedPax(merged.expectedPax);
          if (clean === undefined) delete merged.expectedPax;
          else merged.expectedPax = clean;
        }
        // FIX A.4.5 §2 — bug live esatto: il router ha valorizzato `operation`
        // ma ha omesso `name` pur essendo presente nel messaggio. Backstop
        // deterministico: se manca ancora il nome, prova prima l'estrattore
        // posizionale pax→origin, poi il generico "gruppo <nome>" (mai una
        // regex per nomi specifici).
        if (!merged.name) {
          const opType = classifyMarioOperation({ rawType: op.type, kind: merged.kind, message });
          const recovered = extractMarioDraftSlotsFromMessage(message, opType).name ?? extractBookingGroupQuery(message);
          if (recovered) merged.name = recovered;
        }
        // FIX A.4.4 §5/§6/§16 — una data ESPLICITA nel messaggio corrente vince
        // SEMPRE sul `serviceDate` proposto dall'LLM (`op.collected`) e su
        // quello già nel draft: mai fidarsi ciecamente dell'interpretazione
        // del modello quando il dato è deterministicamente ricavabile. FIX
        // A.4.5 §4/§5 — include anche un intervallo esplicito.
        const explicitDateSlots = parseMarioDraftDateSlots(message, now);
        if (explicitDateSlots) Object.assign(merged, explicitDateSlots);
        const operation = classifyMarioOperation({ rawType: op.type, kind: merged.kind, message });
        const evalR = evaluateMarioOperationPolicy({ operation, collected: merged });
        await setMarioDraftOperation(context.tenantId, context.userId, {
          type: operation,
          collected: merged,
          missing: evalR.missingRequired,
        });
        draftSavedAfter = true;
        draftOperationType = operation;
        draftMissingFields = evalR.missingRequired;
        reason = "operation_from_router";
      } else if (isOperativeClarificationContext(message, existing, detected)) {
        // FIX A.4.2 §2/§4/§12 — guardia deterministica: il router ha capito che
        // manca un dato ma NON ha valorizzato `operation` (bug live). Ricostruisce
        // il draft SOLO da segnali già affidabili (mai inventando slot): il tipo
        // operazione da classifyMarioOperation, il nome gruppo dal generico
        // extractBookingGroupQuery già usato da FASE 3 (nessun regex nuovo
        // per-frase). FIX A.4.3 — in più, pax/origin "evidenti" (unità di
        // misura esplicite: "50 persone/pax", "partenza da X") via
        // extractMarioDraftSlotsFromMessage, e la data via lo stesso
        // parseMarioSlotDate del fast-path deterministico. Ogni campo NON
        // riconosciuto con certezza resta assente (mai inventato): la policy
        // lo segnerà `missing`, non `lastIntent` perso.
        const existingCollected = existing?.collected ?? {};
        const operation = classifyMarioOperation({ rawType: existing?.type, kind: existingCollected.kind, message });
        // FIX A.4.5 §2 — extractMarioDraftSlotsFromMessage ora prova anche il
        // nome (estrattore posizionale pax→origin); extractBookingGroupQuery
        // resta il fallback per il pattern generico "gruppo <nome>".
        const extractedSlots = extractMarioDraftSlotsFromMessage(message, operation);
        const recoveredName = existingCollected.name ? undefined : (extractedSlots.name ?? extractBookingGroupQuery(message));
        // FIX A.4.4 §6/§17 — una data ESPLICITA nel messaggio corrente
        // sostituisce SEMPRE quella già nel draft (anche se presente e magari
        // stale da un turno precedente): mai riusare una data vecchia quando
        // l'utente ne ha appena fornita una nuova e inequivocabile. FIX A.4.5
        // §4/§5 — include anche un intervallo esplicito (serviceDate=inizio,
        // returnDate=fine, draft-only).
        const recoveredDateSlots = parseMarioDraftDateSlots(message, now);
        const cleanExtractedPax = sanitizeExpectedPax(extractedSlots.expectedPax);
        const merged: MarioDraftSlots = {
          ...existingCollected,
          ...(recoveredName ? { name: recoveredName } : {}),
          ...(!existingCollected.expectedPax && cleanExtractedPax !== undefined ? { expectedPax: cleanExtractedPax } : {}),
          ...(!existingCollected.origin && extractedSlots.origin ? { origin: extractedSlots.origin } : {}),
          ...(recoveredDateSlots ?? {}),
        };
        const evalR = evaluateMarioOperationPolicy({ operation, collected: merged });
        await setMarioDraftOperation(context.tenantId, context.userId, {
          type: operation,
          collected: merged,
          missing: evalR.missingRequired,
        });
        draftSavedAfter = true;
        draftOperationType = operation;
        draftMissingFields = evalR.missingRequired;
        reason = "operation_reconstructed";
      } else {
        await updateMarioSession(context.tenantId, context.userId, { lastIntent: "mario_llm_clarification" });
        reason = "non_operative_clarification";
      }

      logMarioDraftPersistence({
        tenantId: context.tenantId,
        userId: context.userId,
        step,
        draftPresentBefore,
        draftSavedAfter,
        draftOperationType,
        draftMissingFields,
        reason,
      });

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
    const { confirmationToken: _ignoredHallucinatedToken, ...rawArguments } = (routed.decision.arguments ?? {}) as Record<string, unknown>;

    // FASE A.4 §5/§27/§28/§30 — GATE POLICY prima di eseguire una preview di
    // CREAZIONE gruppo: se manca un dato OPERATIVO (es. la data per un bus)
    // non si esegue la preview — si salva il draft e si chiede SOLO quello.
    // Se pronta, gli arguments passano dal builder deterministico (mai campi
    // illegali come `origin` — §28/§33).
    const gate = await applyCreatePreviewPolicyGate(context, toolName, rawArguments, message, now);
    if (gate.proceed === false) return gate.result;
    const gateCreate = gate.proceed === true ? gate : null;
    const safeArguments = gateCreate ? gateCreate.toolArgs : rawArguments;

    // FIX A.4.4 §8 — safety check PRIMA della preview: gli arguments inviati
    // devono avere la stessa data canonica del draft che li ha generati (per
    // costruzione lo sono sempre, ma è una rete di sicurezza a costo zero
    // contro una futura divergenza). Nessun dato cliente nel log.
    if (gateCreate && gateCreate.mergedSlots.serviceDate && gateCreate.toolArgs.serviceDate !== gateCreate.mergedSlots.serviceDate) {
      console.info(JSON.stringify({ scope: "mario_date_consistency", date_consistency_mismatch: true, stage: "pre_preview" }));
      return { intent: "mario_llm_clarification", answer: "Ho riscontrato un'incoerenza sulla data: puoi ripetermela?", actions: [] };
    }

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

    // FIX A.4.4 §9 — "trust but verify": se la preview di creazione gruppo
    // torna una service_date diversa da quella inviata negli arguments, NON
    // si mostra "Confermi?" su una data che è cambiata sotto silenzio.
    if (
      toolName === "its.preview_create_booking_group" &&
      typeof safeArguments.serviceDate === "string" &&
      typeof output.service_date === "string" &&
      output.service_date !== safeArguments.serviceDate
    ) {
      console.info(JSON.stringify({ scope: "mario_date_consistency", date_consistency_mismatch: true, stage: "post_preview" }));
      return { intent: "mario_llm_clarification", answer: "Ho riscontrato un'incoerenza sulla data proposta: puoi confermarmi di nuovo per quale giorno?", actions: [] };
    }

    const token = typeof output.confirmationToken === "string" ? output.confirmationToken : null;
    if (token) {
      const executeTool = PREVIEW_TO_EXECUTE_TOOL[toolName];
      if (!executeTool) return staticFallbackAnswer(context, detected); // difesa: preview senza execute mappato

      // FASE A.4 §36 — warning bloccanti (es. pax fermate > totale gruppo):
      // NON confermare silenziosamente. Chiedi conferma del totale o correzione.
      const blocking = (Array.isArray(output.warnings) ? (output.warnings as string[]) : []).filter((w) => BLOCKING_PREVIEW_WARNINGS.has(w));
      if (blocking.length > 0) {
        return { intent: "mario_llm_clarification", answer: paxOverbookedQuestion(toolName, output), actions: bgActionsIfRelevant(toolName) };
      }

      const patch: Partial<Omit<MarioSessionContext, "updatedAt">> = {
        ...deriveContextFromToolOutput(toolName, output),
        pendingConfirmation: { toolName: executeTool, confirmationToken: token, op: toolName, createdAt: Date.now() },
      };
      // §9/§33 — creazione gruppo: tieni il draft aggiornato con gli slot usati
      // (incl. `origin` preservato per il passo successivo). Serve anche per
      // una correzione tipo "anzi 45" DOPO la preview. Ripulito solo alla
      // conferma del write / al reset / al TTL.
      if (gateCreate) {
        patch.draftOperation = {
          type: gateCreate.operation,
          collected: gateCreate.mergedSlots,
          missing: [],
          updatedAt: Date.now(),
        };
      }
      await updateMarioSession(context.tenantId, context.userId, patch);

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
      requestId: context.requestId,
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
      schemaIssuePaths: routed.schemaIssues?.paths,
      schemaIssueCodes: routed.schemaIssues?.codes,
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
  const llmEnabled = isMarioLlmEnabled();
  const shadowMode = isMarioLlmShadowMode();

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
      await clearMarioDraftOperation(context.tenantId, context.userId); // §8
      return { intent: "confirmation_cancelled", answer: "Ok, annullato. Nessuna modifica è stata applicata.", actions: [] };
    }
    // Risposta non sì/no: la preview stale decade, MA se c'è un'operazione in
    // corso il messaggio è quasi sempre una correzione ("anzi 45") → non
    // ripartire da zero, riprendi il draft (§12).
    await clearPendingConfirmation(context.tenantId, context.userId);
    if (llmEnabled) {
      const draftForCorrection = await readMarioDraftOperation(context.tenantId, context.userId);
      if (draftForCorrection && !isDraftReset(message)) {
        return runDraftTurn(context, message, draftForCorrection, now);
      }
      if (draftForCorrection && isDraftReset(message)) {
        await clearMarioDraftOperation(context.tenantId, context.userId);
        return { intent: "operation_cancelled", answer: "Ok, ho annullato l'operazione in corso.", actions: [] };
      }
    }
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

  // FASE A.3 §7 — operazione in costruzione: un messaggio che altrimenti
  // ripartirebbe da zero (unsupported/write_unsupported) o verrebbe mal
  // instradato (booking_group_find/write) va interpretato PRIMA come
  // completamento/correzione del draft. Gli intent READ deterministici chiari
  // (situazione, alert, autisti…) restano sul loro fast-path anche a draft
  // attivo. Reset esplicito → cancella il draft.
  if (llmEnabled && DRAFT_DIVERT_INTENTS.has(detected.intent)) {
    const draft = await readMarioDraftOperation(context.tenantId, context.userId);
    if (draft) {
      if (isDraftReset(message)) {
        await clearMarioDraftOperation(context.tenantId, context.userId);
        return { intent: "operation_cancelled", answer: "Ok, ho annullato l'operazione in corso. Dimmi pure quando vuoi ricominciare.", actions: [] };
      }
      return runDraftTurn(context, message, draft, now);
    }
  }

  if (detected.intent === "unsupported" || detected.intent === "write_unsupported") {
    if (llmEnabled) return runLlmTurn(context, message, detected, now);
    if (shadowMode) await runMarioLlmShadow(context, message);
    return detected.intent === "unsupported"
      ? { intent: "unsupported", answer: UNSUPPORTED_ANSWER, actions: [] }
      : { intent: "write_unsupported", answer: WRITE_UNSUPPORTED_ANSWER, actions: [] };
  }

  // FASE 3 — gruppi prenotazione: READ via tool MCP, WRITE indirizzata al
  // flusso anteprima → conferma (stessa pipeline runTool, nessun secondo motore).
  if (detected.intent.startsWith("booking_group_")) {
    if (detected.intent === "booking_group_write") {
      if (llmEnabled) return runLlmTurn(context, message, detected, now);
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
