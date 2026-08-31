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
import { logMarioLlmRoute, logMarioDraftPersistence, logMarioAmbiguityResolution } from "./telemetry";
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
  extractMarioStopSlotsFromMessage,
  sanitizeExpectedPax,
  resolveBusModeAmbiguity,
  type MarioOperationKey,
  type MarioStopSlot,
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
// FASE A.5.1 §1/§19/§20 — idempotenza gruppo + resume da DB: letture dirette
// (non tool MCP, nessun equivalente esposto all'LLM) sulla stessa fonte di
// verità usata da inspectOperationalBusGroupState/findBookingGroups altrove.
import {
  findBookingGroups,
  inspectOperationalBusGroupState,
  findAvailableBusesForGroup,
  normalizeCityKey,
  type OperationalBusGroupState,
  type AvailableBus,
} from "@/lib/server/booking-groups-service";

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

// ═══════════════════════════════════════════════════════════════════════
// FASE A.5 — workflow operativo bus: dopo la creazione di un gruppo bus
// (create_bus_group / create_exclusive_bus_group) CON un'origine nota, il
// draft non viene azzerato: avanza deterministicamente per fermata andata ->
// servizio andata -> [fermata ritorno -> servizio ritorno, se c'è returnDate]
// -> operativizzazione. Ogni step resta preview -> "Confermi?" -> write (§20,
// nessun bypass della conferma): la catena riusa ESATTAMENTE gli stessi tool
// MCP/policy già esposti per add_booking_group_stop/passengers/
// operationalize_group, mai una seconda business rule (§6/§28 — zero
// chiamate LLM in ogni step, gli slot sono tutti già noti).
// "Fammi un gruppo Juventus da 50" (nessuna origine) resta SOLO il
// contenitore commerciale: isOperationalBusGroupDraft la esclude (§31).
// ═══════════════════════════════════════════════════════════════════════

// FASE A.5.2 §1 — modello fermata: un array di stop sostituisce il singolo
// `origin`. Compatibilità totale: `origin` singolo si normalizza SEMPRE in
// `stops = [{ city: origin, expectedPax: totale, direction: "arrival" }]`
// (stesso comportamento di prima per La Marra/Rimini — vedi normalizeStops).
function normalizeStops(collected: MarioDraftSlots): MarioStopSlot[] {
  const raw = collected.stops;
  if (Array.isArray(raw) && raw.length > 0) {
    return (raw as unknown as MarioStopSlot[]).map((s) => ({
      city: s.city,
      pickupPoint: s.pickupPoint ?? null,
      expectedPax: s.expectedPax,
      direction: s.direction ?? "arrival",
    }));
  }
  if (typeof collected.origin === "string" && collected.origin.trim()) {
    return [
      {
        city: collected.origin.trim(),
        pickupPoint: (collected.pickupPoint as string | undefined) ?? null,
        expectedPax: collected.expectedPax as number,
        direction: "arrival",
      },
    ];
  }
  return [];
}

/** FASE A.5.2 §3 — somma pax fermate vs totale gruppo. `null` se non c'è
 *  nulla da validare (nessuna fermata ancora nota) o se la somma torna. */
function validateStopsPaxSum(merged: MarioDraftSlots): MarioAssistantResult | null {
  const stops = normalizeStops(merged);
  if (stops.length === 0) return null;
  const totalPax = typeof merged.expectedPax === "number" ? merged.expectedPax : undefined;
  if (totalPax === undefined) return null;
  const sum = stops.reduce((acc, s) => acc + (Number.isFinite(s.expectedPax) ? s.expectedPax : 0), 0);
  if (sum === totalPax) return null;
  if (sum < totalPax) {
    return {
      intent: "mario_llm_clarification",
      answer: `Le fermate indicate sommano ${sum} pax su ${totalPax} totali del gruppo. Dove salgono gli altri ${totalPax - sum} pax?`,
      actions: [],
    };
  }
  return {
    intent: "mario_llm_clarification",
    answer: `Le fermate sommano ${sum} pax ma il gruppo è da ${totalPax}.`,
    actions: [],
  };
}

// FASE A.5.2 §1/§7 — stage di catena parametrizzati (indice fermata /
// direzione / indice data di prenotazione bus), codificati come stringa per
// restare compatibili con la persistenza JSON di `MarioDraftSlots`
// (`_chainStage`/`_chainRemaining`, invariati come shape — solo il contenuto
// delle stringhe cambia formato).
type ChainStage =
  | { kind: "stop"; direction: "arrival" | "departure"; index: number }
  | { kind: "passengers"; direction: "arrival" | "departure"; index: number }
  | { kind: "reserve_bus"; dateIndex: 0 | 1 }
  | { kind: "operationalize" };

function encodeStage(s: ChainStage): string {
  if (s.kind === "operationalize") return "operationalize";
  if (s.kind === "reserve_bus") return `reserve_bus:${s.dateIndex}`;
  return `${s.kind}:${s.direction}:${s.index}`;
}
function decodeStage(s: string): ChainStage {
  if (s === "operationalize") return { kind: "operationalize" };
  const parts = s.split(":");
  if (parts[0] === "reserve_bus") return { kind: "reserve_bus", dateIndex: Number(parts[1]) === 1 ? 1 : 0 };
  return { kind: parts[0] as "stop" | "passengers", direction: parts[1] as "arrival" | "departure", index: Number(parts[2]) };
}

/** Marcatore di `draftOperation.type` per il resto della catena (dopo la
 *  creazione del gruppo): `type` non è più una MarioOperationKey pura perché
 *  la catena può attraversare più operazioni diverse in sequenza — lo stage
 *  corrente/i restanti vivono in `collected._chainStage`/`_chainRemaining`. */
const OPERATIONAL_CHAIN_MARKER = "operational_bus_group_chain";

function buildOperationalChainPlan(collected: MarioDraftSlots): ChainStage[] {
  const stops = normalizeStops(collected);
  const stages: ChainStage[] = [];
  stops.forEach((_, i) => {
    stages.push({ kind: "stop", direction: "arrival", index: i });
    stages.push({ kind: "passengers", direction: "arrival", index: i });
  });
  const hasReturn = typeof collected.returnDate === "string" && collected.returnDate.trim().length > 0;
  if (hasReturn) {
    // FASE A.5.2 §5 — il ritorno riusa la STESSA distribuzione città/pax
    // dell'andata (nessuna distribuzione di ritorno diversa gestita qui).
    stops.forEach((_, i) => {
      stages.push({ kind: "stop", direction: "departure", index: i });
      stages.push({ kind: "passengers", direction: "departure", index: i });
    });
  }
  if (collected.kind === "bus_exclusive") {
    // FASE A.5.2 §7/§8 — bus esclusivo: una reservation per ogni data
    // operativa nota (andata sempre, ritorno solo se presente).
    stages.push({ kind: "reserve_bus", dateIndex: 0 });
    if (hasReturn) stages.push({ kind: "reserve_bus", dateIndex: 1 });
  }
  stages.push({ kind: "operationalize" });
  return stages;
}

/** §31 — solo un gruppo bus OPERATIVO (kind bus_group/bus_exclusive) CON
 *  un'origine o almeno una fermata nota innesca la catena oltre alla sola
 *  creazione (FASE A.5.2 §1 — `stops` è l'estensione di `origin`). */
function isOperationalBusGroupDraft(draft: MarioDraftOperation | null): boolean {
  if (!draft) return false;
  if (draft.type !== "create_bus_group" && draft.type !== "create_exclusive_bus_group") return false;
  const hasOrigin = typeof draft.collected.origin === "string" && draft.collected.origin.trim().length > 0;
  const hasStops = Array.isArray(draft.collected.stops) && (draft.collected.stops as unknown[]).length > 0;
  return hasOrigin || hasStops;
}

function chainStageLabel(stage: ChainStage, collected: MarioDraftSlots): string {
  if (stage.kind === "operationalize") return "l'operativizzazione dei servizi";
  if (stage.kind === "reserve_bus") return stage.dateIndex === 0 ? "la prenotazione del bus per l'andata" : "la prenotazione del bus per il ritorno";
  const stops = normalizeStops(collected);
  const city = stops[stage.index]?.city ?? "la fermata";
  const dirLabel = stage.direction === "arrival" ? "andata" : "ritorno";
  return stage.kind === "stop" ? `la fermata di ${dirLabel} (${city})` : `i pax di ${dirLabel} a ${city}`;
}

/** §J/§K/§L — costruisce operation+slot per lo stage indicato riusando le
 *  STESSE MarioOperationKey/policy di add_booking_group_stop/passengers/
 *  operationalize_group/reserve_bus_for_group: nessuna business rule nuova,
 *  solo composizione deterministica di dati già raccolti (mai testo libero,
 *  mai LLM). Un nominativo aggregato ("Gruppo <nome>", pax=pax dello STOP,
 *  FASE A.5.2 §4 — non il totale del gruppo) evita di inventare N nominativi
 *  fittizi (§12/§J).
 */
function buildChainStepInput(stage: ChainStage, collected: MarioDraftSlots): { operation: MarioOperationKey; slots: MarioDraftSlots } {
  const bookingGroupId = collected.bookingGroupId as string;

  if (stage.kind === "operationalize") {
    return { operation: "operationalize_group", slots: { bookingGroupId } };
  }

  if (stage.kind === "reserve_bus") {
    const dateField = stage.dateIndex === 0 ? "serviceDate" : "returnDate";
    const busField = stage.dateIndex === 0 ? "reserveBusUnitId0" : "reserveBusUnitId1";
    return {
      operation: "reserve_bus_for_group",
      slots: {
        bookingGroupId,
        busUnitId: collected[busField] as string,
        serviceDate: collected[dateField] as string,
        reservedPax: collected.expectedPax as number,
        exclusive: true,
      },
    };
  }

  const stops = normalizeStops(collected);
  const stop = stops[stage.index]!;
  const groupName = (collected.name as string | undefined) ?? "Gruppo";

  if (stage.kind === "stop") {
    return {
      operation: "add_booking_group_stop",
      slots: {
        bookingGroupId,
        city: stop.city,
        pickupPoint: stop.pickupPoint ?? undefined,
        expectedPax: stop.expectedPax,
        direction: stage.direction,
      },
    };
  }

  const idsField = stage.direction === "arrival" ? "outboundStopIds" : "returnStopIds";
  const ids = ((collected[idsField] as unknown as string[] | undefined) ?? []) as string[];
  const stopId = ids[stage.index];
  const slots: MarioDraftSlots = {
    bookingGroupId,
    bookingGroupStopId: stopId,
    // FASE A.5.2 §4 — pax dello STOP corrente, mai il totale del gruppo.
    passengers: [{ customerName: `Gruppo ${groupName}`, pax: stop.expectedPax }] as unknown as unknown[],
  };
  if (stage.direction === "departure" && typeof collected.returnDate === "string") {
    slots.serviceDate = collected.returnDate;
  }
  return { operation: "add_booking_group_passengers", slots };
}

/** Esegue la preview dello stage indicato (zero LLM, §28) e salva il nuovo
 *  pendingConfirmation + draft di catena. §M — per `operationalize`, se la
 *  readiness live risulta 0 servizi pronti, NON propone "Confermi?" su un
 *  no-op: riporta cosa manca e chiude la catena (il gruppo resta ripercorribile
 *  da Gruppi prenotazione / da un comando Mario successivo, §22).
 *
 *  FASE A.5.2 §7 — se lo stage è `reserve_bus` e il bus da usare non è ancora
 *  noto (`collected.reserveBusUnitId{0,1}` assente), NON si esegue nessuna
 *  preview: si delega a `runReserveBusSelectStep`, che elenca i mezzi
 *  disponibili (mai una scelta arbitraria di Mario, §7.3/§7.4).
 */
async function runOperationalChainStep(
  context: McpContext,
  stage: ChainStage,
  collected: MarioDraftSlots,
  remaining: ChainStage[],
): Promise<MarioAssistantResult> {
  if (stage.kind === "reserve_bus") {
    const busField = stage.dateIndex === 0 ? "reserveBusUnitId0" : "reserveBusUnitId1";
    if (!collected[busField]) {
      return runReserveBusSelectStep(context, stage, collected, remaining);
    }
  }

  const { operation, slots } = buildChainStepInput(stage, collected);
  const evalR = evaluateMarioOperationPolicy({ operation, collected: slots as Record<string, unknown> });
  if (!evalR.readyForPreview) {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return {
      intent: "mario_operational_chain_error",
      answer: `Gruppo creato, ma non riesco a proseguire con ${chainStageLabel(stage, collected)}: mancano ${evalR.missingRequired.join(", ") || "dei dati"}. Puoi completarlo da Gruppi prenotazione.`,
      actions: BG_ACTIONS,
    };
  }

  const previewToolName = MARIO_OPERATION_POLICIES[operation].mcpTool;
  const tool = getTool(previewToolName);
  const failMessage = `Gruppo creato, ma non riesco a preparare ${chainStageLabel(stage, collected)} adesso. Puoi completarlo da Gruppi prenotazione.`;
  if (!tool) {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return { intent: "mario_operational_chain_error", answer: failMessage, actions: BG_ACTIONS };
  }

  const args = buildMcpArguments(operation, slots as Record<string, unknown>);
  const raw = await runTool(context, tool, args);
  if (!isMcpToolContentResult(raw) || raw.isError) {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return { intent: "mario_operational_chain_error", answer: failMessage, actions: BG_ACTIONS };
  }
  let output: Record<string, unknown> = {};
  try {
    output = raw.content[0]?.text ? (JSON.parse(raw.content[0]!.text!) as Record<string, unknown>) : {};
  } catch {
    output = {};
  }

  if (operation === "operationalize_group" && Number(output.services_ready ?? 0) === 0) {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    const blockedSvc = (output.services as Array<{ ready?: boolean; already_operational?: boolean; missing_fields?: string[] }> | undefined) ?? [];
    const missing = new Set<string>();
    for (const s of blockedSvc) if (!s.ready && !s.already_operational) (s.missing_fields ?? []).forEach((f) => missing.add(f));
    const missingText = missing.size ? ` Mancano: ${[...missing].join(", ")}.` : "";
    return {
      intent: "mario_operational_chain_blocked",
      answer: `Ho preparato andata${remaining.length || collected.returnDate ? " e ritorno" : ""} del gruppo, ma nessun servizio risulta pronto per l'operativizzazione.${missingText} Puoi completarlo da Gruppi prenotazione.`,
      actions: BG_ACTIONS,
      data: output,
    };
  }

  const token = typeof output.confirmationToken === "string" ? output.confirmationToken : null;
  if (!token) {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return { intent: "mario_operational_chain_error", answer: failMessage, actions: BG_ACTIONS };
  }
  const executeTool = PREVIEW_TO_EXECUTE_TOOL[previewToolName] ?? previewToolName;

  await updateMarioSession(context.tenantId, context.userId, {
    ...deriveContextFromToolOutput(previewToolName, output),
    draftOperation: {
      type: OPERATIONAL_CHAIN_MARKER,
      collected: { ...collected, _chainStage: encodeStage(stage), _chainRemaining: remaining.map(encodeStage) as unknown as unknown[] },
      missing: [],
      updatedAt: Date.now(),
    },
    pendingConfirmation: { toolName: executeTool, confirmationToken: token, op: previewToolName, createdAt: Date.now() },
  });

  return { intent: "mario_operational_chain_pending", answer: buildConfirmationPrompt(previewToolName, output), actions: bgActionsIfRelevant(previewToolName) };
}

/**
 * FASE A.5.2 §7 — step "elenco/scelta bus" per una reservation esclusiva:
 * MAI un preview/token qui (non c'è ancora un bus scelto). Legge i mezzi
 * compatibili via `findAvailableBusesForGroup` (stessa fonte di verità READ
 * usata altrove, §7.1) per la data corrente e — se è la PRIMA delle due date
 * (§8) — anche per l'eventuale data di ritorno, per proporre UN bus valido
 * per entrambe quando possibile. Se resta un solo candidato compatibile lo
 * propone MA chiede comunque conferma esplicita (richiamando
 * `runOperationalChainStep`, che a quel punto trova il bus già assegnato e
 * procede con la preview normale — mai un bypass della conferma, §7.6). Se
 * restano più candidati, salva lo stato di attesa e chiede quale usare (mai
 * una scelta arbitraria, §7.3/§7.4): la risposta dell'utente è risolta da
 * `resolveReserveBusSelection`.
 */
async function runReserveBusSelectStep(
  context: McpContext,
  stage: Extract<ChainStage, { kind: "reserve_bus" }>,
  collected: MarioDraftSlots,
  remaining: ChainStage[],
): Promise<MarioAssistantResult> {
  const expectedPax = collected.expectedPax as number;
  const serviceDate = collected.serviceDate as string;
  const returnDate = typeof collected.returnDate === "string" ? collected.returnDate : undefined;
  const targetDate = stage.dateIndex === 0 ? serviceDate : (returnDate as string);
  const groupName = (collected.name as string | undefined) ?? "il gruppo";
  const dateLabel = formatMarioDateForUser(targetDate) ?? targetDate;
  const exclusiveOnly = collected.kind === "bus_exclusive";

  let candidates: AvailableBus[];
  try {
    candidates = await findAvailableBusesForGroup(context.admin, context.tenantId, { serviceDate: targetDate, requiredCapacity: expectedPax, exclusiveOnly });
  } catch {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return { intent: "mario_operational_chain_error", answer: `Gruppo pronto, ma non riesco a verificare i bus disponibili per il ${dateLabel}. Puoi completare da Gruppi prenotazione.`, actions: BG_ACTIONS };
  }
  if (candidates.length === 0) {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return {
      intent: "mario_operational_chain_blocked",
      answer: `Nessun bus con capienza sufficiente (${expectedPax} pax) risulta disponibile per il ${dateLabel}. Puoi verificare da Linea Bus / Gruppi prenotazione.`,
      actions: BG_ACTIONS,
    };
  }

  // FASE A.5.2 §8 — alla prima data, se c'è anche un ritorno, preferisci un
  // bus disponibile su ENTRAMBE le date.
  let chosenSet = candidates;
  let coversBothDates = false;
  if (stage.dateIndex === 0 && returnDate) {
    try {
      const returnCandidates = await findAvailableBusesForGroup(context.admin, context.tenantId, { serviceDate: returnDate, requiredCapacity: expectedPax, exclusiveOnly });
      const returnIds = new Set(returnCandidates.map((b) => b.id));
      const both = candidates.filter((b) => returnIds.has(b.id));
      if (both.length > 0) {
        chosenSet = both;
        coversBothDates = true;
      }
    } catch {
      // §8 — se la verifica sulla seconda data fallisce, si procede solo
      // sulla data corrente: la seconda resta un passo separato più avanti.
    }
  }

  if (chosenSet.length === 1) {
    const bus = chosenSet[0]!;
    const updated: MarioDraftSlots = { ...collected };
    (updated as Record<string, unknown>)[stage.dateIndex === 0 ? "reserveBusUnitId0" : "reserveBusUnitId1"] = bus.id;
    if (coversBothDates) (updated as Record<string, unknown>).reserveBusUnitId1 = bus.id;
    return runOperationalChainStep(context, stage, updated, remaining);
  }

  // §7.4 — più di un candidato compatibile: Mario NON sceglie, chiede.
  const label = coversBothDates
    ? `andata ${formatMarioDateForUser(serviceDate) ?? serviceDate} e ritorno ${formatMarioDateForUser(returnDate!) ?? returnDate}`
    : `il ${dateLabel}`;
  await updateMarioSession(context.tenantId, context.userId, {
    draftOperation: {
      type: OPERATIONAL_CHAIN_MARKER,
      collected: {
        ...collected,
        _chainStage: encodeStage(stage),
        _chainRemaining: remaining.map(encodeStage) as unknown as unknown[],
        _reserveBusCandidates: chosenSet.map((b) => ({ id: b.id, label: b.label, capacity: b.capacity })) as unknown as unknown[],
        _reserveBusCoversBoth: coversBothDates,
      },
      missing: [],
      updatedAt: Date.now(),
    },
  });
  const list = chosenSet.map((b) => `${b.label} (${b.capacity} posti)`).join(", ");
  return {
    intent: "mario_operational_chain_pending_selection",
    answer: `Per ${label} sono disponibili questi bus per il gruppo «${groupName}» (${expectedPax} pax): ${list}. Quale devo usare?`,
    actions: BG_ACTIONS,
  };
}

/**
 * FASE A.5.2 §7 — risolve la risposta dell'utente a "Quale bus devo usare?"
 * (turno successivo, draft già in attesa di scelta): match deterministico sul
 * nome/etichetta del bus o su un numero che compare in un solo candidato — MAI
 * una scelta arbitraria se il messaggio non identifica univocamente un solo
 * candidato (si richiede di ripetere la scelta tra le opzioni note).
 */
async function resolveReserveBusSelection(context: McpContext, message: string, collected: MarioDraftSlots): Promise<MarioAssistantResult> {
  const candidates = ((collected._reserveBusCandidates as unknown[] | undefined) ?? []) as Array<{ id: string; label: string; capacity: number }>;
  const stage = decodeStage(collected._chainStage as string) as Extract<ChainStage, { kind: "reserve_bus" }>;
  const remaining = ((collected._chainRemaining as unknown[] | undefined) ?? []).map((s) => decodeStage(s as string));
  const coversBoth = Boolean(collected._reserveBusCoversBoth);

  const norm = message.trim().toLowerCase();
  const matches = candidates.filter((c) => {
    const label = c.label.toLowerCase();
    if (norm.includes(label)) return true;
    const num = label.match(/\d+/)?.[0];
    return Boolean(num) && new RegExp(`(?<!\\d)${num}(?!\\d)`).test(norm);
  });

  if (matches.length !== 1) {
    return {
      intent: "mario_llm_clarification",
      answer: `Non ho capito quale bus scegliere. Dimmi il nome esatto tra: ${candidates.map((c) => c.label).join(", ")}.`,
      actions: BG_ACTIONS,
    };
  }

  const bus = matches[0]!;
  const updated: MarioDraftSlots = { ...collected };
  if (stage.dateIndex === 0) {
    (updated as Record<string, unknown>).reserveBusUnitId0 = bus.id;
    if (coversBoth) (updated as Record<string, unknown>).reserveBusUnitId1 = bus.id;
  } else {
    (updated as Record<string, unknown>).reserveBusUnitId1 = bus.id;
  }
  delete (updated as Record<string, unknown>)._reserveBusCandidates;
  delete (updated as Record<string, unknown>)._reserveBusCoversBoth;
  return runOperationalChainStep(context, stage, updated, remaining);
}

/**
 * FASE A.5.3 §2/§3 — confronta le fermate ATTESE (dal draft/messaggio
 * corrente, o dal DB se il draft non le conosce più — mai indovinate) con lo
 * stato REALE del DB (`state`, fonte di verità) e calcola l'elenco COMPLETO
 * degli step ancora mancanti — non solo il primo indice (limite residuo
 * A.5.2 chiuso qui). Per ogni fermata attesa, andata e — se `returnDate` è
 * presente — ritorno:
 *  - fermata già in DB (stessa città, §2) → riusata (id noto), MAI un secondo
 *    `add_booking_group_stop` a meno che le manchi ancora il service;
 *  - fermata assente → creata (stage `stop` + `passengers`);
 *  - fermata presente ma senza service → creato SOLO il service mancante.
 * Se non c'è alcuna fermata attesa nota (né nel draft né nel DB) si chiede
 * chiarimento (§4) invece di inventare una distribuzione.
 */
type ResumePlanResult =
  | { kind: "ready"; stages: ChainStage[]; collected: MarioDraftSlots }
  | { kind: "need_clarification"; message: string };

function computeMultiStopResumePlan(state: OperationalBusGroupState, collected: MarioDraftSlots): ResumePlanResult {
  const groupName = (collected.name as string | undefined) ?? state.group?.name ?? "il gruppo";
  const hasReturn = typeof collected.returnDate === "string" && collected.returnDate.trim().length > 0;

  let expectedStops = normalizeStops(collected);
  if (expectedStops.length === 0) {
    if (state.arrivalStops.length > 0) {
      // §4 — Redis perso ma il DB conosce già le fermate: si ricostruiscono
      // da lì, mai indovinate da zero.
      expectedStops = state.arrivalStops.map((s) => ({
        city: s.city,
        pickupPoint: s.pickup_point,
        expectedPax: s.expected_pax,
        direction: "arrival" as const,
      }));
    } else {
      return {
        kind: "need_clarification",
        message: `Il gruppo «${groupName}» esiste ma non ho più il contesto delle fermate (sessione scaduta) e non ne risulta ancora nessuna registrata. Ripetimi la distribuzione (es. "20 Tivoli e 30 Guidonia") per proseguire.`,
      };
    }
  }

  const outboundStopIds: Array<string | undefined> = new Array(expectedStops.length).fill(undefined);
  const returnStopIds: Array<string | undefined> = new Array(expectedStops.length).fill(undefined);
  const arrivalMissingServiceIds = new Set(state.arrivalStopsMissingService.map((s) => s.id));
  const departureMissingServiceIds = new Set(state.departureStopsMissingService.map((s) => s.id));
  const stages: ChainStage[] = [];

  expectedStops.forEach((stop, i) => {
    const key = normalizeCityKey(stop.city);
    const dbStop = state.arrivalStops.find((s) => normalizeCityKey(s.city) === key);
    if (dbStop) {
      outboundStopIds[i] = dbStop.id;
      if (arrivalMissingServiceIds.has(dbStop.id)) stages.push({ kind: "passengers", direction: "arrival", index: i });
    } else {
      stages.push({ kind: "stop", direction: "arrival", index: i });
      stages.push({ kind: "passengers", direction: "arrival", index: i });
    }
  });

  if (hasReturn) {
    expectedStops.forEach((stop, i) => {
      const key = normalizeCityKey(stop.city);
      const dbStop = state.departureStops.find((s) => normalizeCityKey(s.city) === key);
      if (dbStop) {
        returnStopIds[i] = dbStop.id;
        if (departureMissingServiceIds.has(dbStop.id)) stages.push({ kind: "passengers", direction: "departure", index: i });
      } else {
        stages.push({ kind: "stop", direction: "departure", index: i });
        stages.push({ kind: "passengers", direction: "departure", index: i });
      }
    });
  }

  const isExclusive = collected.kind === "bus_exclusive" || state.group?.kind === "bus_exclusive";
  if (isExclusive) {
    const svcDate = collected.serviceDate as string | undefined;
    const retDate = hasReturn ? (collected.returnDate as string) : undefined;
    if (svcDate && !state.reservations.some((r) => r.service_date === svcDate)) stages.push({ kind: "reserve_bus", dateIndex: 0 });
    if (retDate && !state.reservations.some((r) => r.service_date === retDate)) stages.push({ kind: "reserve_bus", dateIndex: 1 });
  }

  stages.push({ kind: "operationalize" });

  const finalCollected: MarioDraftSlots = {
    ...collected,
    stops: expectedStops as unknown as unknown[],
    outboundStopIds: outboundStopIds as unknown as unknown[],
    returnStopIds: returnStopIds as unknown as unknown[],
  };
  return { kind: "ready", stages, collected: finalCollected };
}

/**
 * FASE A.5.1 §1/§19/§20 — riprende la catena da uno stato letto DAL DB
 * (`inspectOperationalBusGroupState`, fonte di verità), non dalla sessione:
 * copre sia il riuso di un gruppo già esistente (comando ripetuto, §1) sia il
 * resume dopo scadenza Redis (§19) — stesso percorso deterministico, mai un
 * secondo insert. FASE A.5.2 §7/§10 — `reserve_bus` non è più un vicolo
 * cieco: riprende la catena reale (elenco/scelta bus) invece di rimandare
 * l'utente alla UI. FASE A.5.3 §2/§3 — gli step "add_outbound_*"/
 * "add_return_*" usano SEMPRE il piano multi-stop completo
 * (`computeMultiStopResumePlan`), mai un singolo indice hardcoded: una
 * ripresa a metà di un gruppo con più fermate (una creata, l'altra no)
 * crea solo ciò che manca, in qualunque ordine di completamento si trovi.
 */
async function resumeOperationalChainFromState(
  context: McpContext,
  state: OperationalBusGroupState,
  collected: MarioDraftSlots,
): Promise<MarioAssistantResult> {
  const groupName = (collected.name as string | undefined) ?? state.group?.name ?? "il gruppo";

  switch (state.nextStep) {
    case "add_outbound_stop":
    case "add_outbound_service":
    case "add_return_stop":
    case "add_return_service": {
      const plan = computeMultiStopResumePlan(state, collected);
      if (plan.kind === "need_clarification") {
        await setMarioDraftOperation(context.tenantId, context.userId, { type: "operational_bus_group_chain", collected, missing: [] });
        return { intent: "mario_llm_clarification", answer: plan.message, actions: BG_ACTIONS };
      }
      const [first, ...rest] = plan.stages;
      if (!first) {
        // Tutte le fermate attese risultano già complete (caso limite: lo
        // stato DB era già avanzato oltre quanto suggeriva `nextStep`) →
        // operativizzazione diretta, mai un vicolo cieco.
        return runOperationalChainStep(context, { kind: "operationalize" }, plan.collected, []);
      }
      return runOperationalChainStep(context, first, plan.collected, rest);
    }
    case "reserve_bus": {
      // FASE A.5.2 §10 — resume su reserve_bus: riprende dalla prenotazione
      // mezzo (elenco/scelta reale), MAI dalla creazione del gruppo. Le
      // fermate risultano già tutte complete qui (§3), quindi il piano
      // multi-stop non produce stage stop/passengers residui.
      const plan = computeMultiStopResumePlan(state, collected);
      if (plan.kind === "need_clarification") {
        // Non dovrebbe accadere (le fermate sono già in DB se si è arrivati
        // a reserve_bus), ma resta una rete di sicurezza deterministica.
        await setMarioDraftOperation(context.tenantId, context.userId, { type: "operational_bus_group_chain", collected, missing: [] });
        return { intent: "mario_llm_clarification", answer: plan.message, actions: BG_ACTIONS };
      }
      const [first, ...rest] = plan.stages;
      return runOperationalChainStep(context, first!, plan.collected, rest);
    }
    case "operationalize":
      return runOperationalChainStep(context, { kind: "operationalize" }, collected, []);
    case "blocked":
      await clearMarioDraftOperation(context.tenantId, context.userId);
      return { intent: "mario_operational_chain_blocked", answer: `Il gruppo «${groupName}» esiste già, ma alcuni servizi risultano bloccati. Puoi verificarli da Gruppi prenotazione.`, actions: BG_ACTIONS };
    case "completed":
    default:
      await clearMarioDraftOperation(context.tenantId, context.userId);
      return { intent: "mario_operational_chain_reused", answer: `Il gruppo «${groupName}» esiste già e risulta completo. Nessuna nuova operazione necessaria.`, actions: BG_ACTIONS };
  }
}

/** §26 — dopo OGNI write confermato, decide se un workflow di catena deve
 *  proseguire. Ritorna `null` quando il write non fa parte di alcuna catena
 *  (comportamento invariato: "Fatto. Operazione completata."). */
async function maybeAdvanceOperationalChain(
  context: McpContext,
  executedToolName: string,
  output: Record<string, unknown>,
): Promise<MarioAssistantResult | null> {
  const draft = await readMarioDraftOperation(context.tenantId, context.userId);

  if (executedToolName === "its.create_booking_group") {
    if (!isOperationalBusGroupDraft(draft)) return null;
    const bookingGroupId = typeof output.bookingGroupId === "string" ? output.bookingGroupId : null;
    if (!bookingGroupId) return null;
    const collected: MarioDraftSlots = { ...draft!.collected, bookingGroupId };
    const [first, ...rest] = buildOperationalChainPlan(collected);
    if (!first) return null;
    const groupName = (collected.name as string | undefined) ?? "il gruppo";
    const step = await runOperationalChainStep(context, first, collected, rest);
    return { ...step, answer: `Gruppo «${groupName}» creato. Ora preparo ${chainStageLabel(first, collected)}. ${step.answer}` };
  }

  if (!draft || draft.type !== OPERATIONAL_CHAIN_MARKER) return null;
  const remaining = ((draft.collected._chainRemaining as unknown[] | undefined) ?? []).map((s) => decodeStage(s as string));
  const currentStageStr = draft.collected._chainStage as string | undefined;
  const currentStage = currentStageStr ? decodeStage(currentStageStr) : undefined;

  if (executedToolName === "its.add_booking_group_stop") {
    const stopId = typeof output.bookingGroupStopId === "string" ? output.bookingGroupStopId : null;
    if (!currentStage || currentStage.kind !== "stop" || !stopId) return null;
    const idsField = currentStage.direction === "arrival" ? "outboundStopIds" : "returnStopIds";
    const existingIds = ((draft.collected[idsField] as unknown as string[] | undefined) ?? []).slice();
    existingIds[currentStage.index] = stopId;
    const collected: MarioDraftSlots = { ...draft.collected, [idsField]: existingIds as unknown as unknown[] };
    const [next, ...rest] = remaining;
    if (!next) return null;
    return runOperationalChainStep(context, next, collected, rest);
  }

  if (executedToolName === "its.add_booking_group_passengers" || executedToolName === "its.reserve_booking_group_bus") {
    const [next, ...rest] = remaining;
    if (!next) return null;
    return runOperationalChainStep(context, next, draft.collected, rest);
  }

  if (executedToolName === "its.operationalize_booking_group") {
    // §26 — riepilogo finale: workflow concluso, il draft non serve più.
    await clearMarioDraftOperation(context.tenantId, context.userId);
    const collected = draft.collected;
    const groupName = (collected.name as string | undefined) ?? "Il gruppo";
    const outboundLabel = formatMarioDateForUser((collected.serviceDate as string | undefined) ?? null);
    const returnLabel = formatMarioDateForUser((collected.returnDate as string | undefined) ?? null);
    const stopsList = normalizeStops(collected);
    const stopsSummary = stopsList.map((s) => `${s.city} ${s.expectedPax}`).join(", ");
    const lines = [
      `Gruppo «${groupName}» caricato correttamente:`,
      `- andata ${outboundLabel ?? "-"}`,
      ...(returnLabel ? [`- ritorno ${returnLabel}`] : []),
      `- ${collected.expectedPax ?? "?"} pax (${stopsSummary || (collected.origin as string | undefined) || "-"})`,
      "- servizi operativi",
    ];
    return { intent: "mario_operational_chain_completed", answer: lines.join("\n"), actions: BG_ACTIONS, data: output };
  }

  return null;
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

  // FASE A.5 §G/§R — un write che fa parte del workflow operativo bus avanza
  // automaticamente allo step successivo invece di chiudere il turno.
  const chainResult = await maybeAdvanceOperationalChain(context, pending.toolName, output);
  if (chainResult) return chainResult;

  // §9 — operazione completata e confermata (nessuna catena in corso): il
  // draft non serve più.
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
  // FASE A.5.2 §7 — draft in attesa di scelta bus (più candidati compatibili,
  // §7.4): il messaggio corrente è la risposta a "quale devo usare?", non una
  // nuova richiesta. Vince su qualunque altra interpretazione del draft.
  if (draft.type === OPERATIONAL_CHAIN_MARKER && Array.isArray(draft.collected._reserveBusCandidates) && (draft.collected._reserveBusCandidates as unknown[]).length > 0) {
    return resolveReserveBusSelection(context, message, draft.collected);
  }

  // FIX A.4.7 §3/§4/§5/§8 — un'ambiguità "busMode" aperta sul draft vince
  // sull'interpretazione generica della frase: il contesto locale del draft
  // decide, mai una nuova domanda generica ("vuoi un gruppo o assegnare un
  // mezzo?") su un dubbio già risolto dal turno precedente. Zero chiamate LLM
  // se la risposta è deterministicamente univoca (§8, cost control).
  if (draft.ambiguities?.includes("busMode")) {
    const resolution = resolveBusModeAmbiguity(message);
    if (resolution) {
      const resolvedOperation: MarioOperationKey = resolution === "exclusive" ? "create_exclusive_bus_group" : "create_bus_group";
      logMarioAmbiguityResolution({
        tenantId: context.tenantId,
        userId: context.userId,
        ambiguityPresent: true,
        ambiguityResolved: true,
        ambiguityCode: "busMode",
      });
      const evalR = evaluateMarioOperationPolicy({ operation: resolvedOperation, collected: draft.collected });
      if (evalR.readyForPreview) {
        return runDraftDirectPreview(context, resolvedOperation, draft.collected); // §9 — zero LLM, preview immediata
      }
      // §7 — merge priority: tutti gli slot già raccolti restano intatti,
      // solo `type`/`ambiguities` cambiano.
      await setMarioDraftOperation(context.tenantId, context.userId, {
        type: resolvedOperation,
        collected: draft.collected,
        missing: evalR.missingRequired,
        ambiguities: [],
      });
      return { intent: "mario_llm_clarification", answer: questionForMissingField(evalR.nextQuestionField), actions: [] }; // zero LLM
    }
  }

  const fast = tryDeterministicDraftFill(draft, message, now);
  if (fast) return runDraftDirectPreview(context, fast.operation, fast.slots); // nessuna chiamata LLM
  return runLlmTurn(context, message, { intent: "booking_group_write", params: {} }, now);
}

type CreateGateResult =
  | { proceed: false; result: MarioAssistantResult }
  | { proceed: true; operation: MarioOperationKey; mergedSlots: MarioDraftSlots; toolArgs: Record<string, unknown> }
  | { proceed: "passthrough" }
  // FASE A.5.1 §1/§19 — un gruppo NON cancellato con lo stesso nome (+ stessa
  // data se nota) esiste già: il gate NON esegue una nuova preview_create, il
  // risultato è già pronto (riuso + reconciliation/resume dal DB).
  | { proceed: "reuse"; result: MarioAssistantResult };

const GROUP_CREATE_OPERATIONS = new Set<MarioOperationKey>(["create_bus_group", "create_exclusive_bus_group", "create_generic_booking_group"]);

/**
 * FASE A.5.1 §1/§18/§19/§20 — idempotenza a livello di GRUPPO: prima di
 * proporre una nuova `preview_create_booking_group`, verifica se esiste già
 * un gruppo non cancellato con lo stesso nome (+ stessa `service_date` se
 * nota). Riusa `findBookingGroups` (stessa fonte di verità del tool MCP
 * `its.find_booking_group`, §18): un solo match → riprende il workflow dal
 * punto esatto in cui si trova nel DB (mai da Redis/sessione, §19/§20); più
 * match → chiarimento; nessun match aperto (o solo cancellati) → si procede
 * a creare normalmente.
 */
async function checkGroupIdempotency(
  context: McpContext,
  operation: MarioOperationKey,
  merged: MarioDraftSlots,
): Promise<{ result: MarioAssistantResult } | null> {
  if (!GROUP_CREATE_OPERATIONS.has(operation)) return null;
  const name = typeof merged.name === "string" ? merged.name.trim() : "";
  if (!name) return null;

  // Difensivo: `context.admin` è sempre un client Supabase reale a runtime;
  // in ambienti/test dove non lo è (double senza `.from`), l'idempotenza
  // diventa un no-op invece di far fallire l'intero turno — la creazione
  // procede come se nessun gruppo esistente fosse stato trovato.
  let found: Awaited<ReturnType<typeof findBookingGroups>>;
  try {
    const serviceDate = typeof merged.serviceDate === "string" ? merged.serviceDate : null;
    found = await findBookingGroups(context.admin, context.tenantId, { query: name, serviceDate });
  } catch {
    return null;
  }
  if (found.strategy !== "exact" && found.strategy !== "exact_same_date") return null;

  const nonCancelled = found.matches.filter((m) => m.status !== "cancelled");
  if (nonCancelled.length === 0) return null; // solo cancellati (o nessuno) → crea normalmente

  if (nonCancelled.length > 1) {
    await setMarioDraftOperation(context.tenantId, context.userId, { type: operation, collected: merged, missing: [] });
    return {
      result: {
        intent: "mario_llm_clarification",
        answer: `Ho trovato più gruppi «${name}» già aperti. Quale intendi riprendere? (${nonCancelled.map((m) => `${m.id.slice(0, 8)}…`).join(", ")})`,
        actions: BG_ACTIONS,
      },
    };
  }

  const bookingGroupId = nonCancelled[0]!.id;
  const groupName = nonCancelled[0]!.name;
  const expectReturn = typeof merged.returnDate === "string" && merged.returnDate.trim().length > 0;
  let state: OperationalBusGroupState;
  try {
    state = await inspectOperationalBusGroupState(context.admin, context.tenantId, bookingGroupId, {
      expectReturn,
      returnDate: expectReturn ? (merged.returnDate as string) : null,
    });
  } catch {
    return null;
  }
  const collected: MarioDraftSlots = { ...merged, name: groupName, bookingGroupId };

  if (operation === "create_generic_booking_group") {
    await clearMarioDraftOperation(context.tenantId, context.userId);
    return { result: { intent: "mario_operational_chain_reused", answer: `Il gruppo «${groupName}» esiste già: lo riprendo invece di crearne uno nuovo.`, actions: BG_ACTIONS } };
  }

  return { result: await resumeOperationalChainFromState(context, state, collected) };
}

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
  // FASE A.5.2 §2 — più fermate nello stesso messaggio ("20 Tivoli e 30
  // Guidonia"): vince solo se il parser trova ALMENO due fermate valide
  // (§2), altrimenti resta il singolo `origin` già gestito sopra.
  const stopSlots = extractMarioStopSlotsFromMessage(message);
  if (stopSlots) merged.stops = stopSlots as unknown as unknown[];
  const operation = classifyMarioOperation({ toolName, kind: merged.kind, message });
  // FASE A.5.2 §7 — `merged.kind` deve riflettere SEMPRE l'operazione risolta
  // (mai lasciato undefined quando l'operazione è bus_exclusive/bus_group):
  // la catena operativa usa questo campo per decidere se inserire gli step
  // di prenotazione bus esclusivo.
  const forcedKind = MARIO_OPERATION_POLICIES[operation].forcedKind;
  if (forcedKind) merged.kind = forcedKind;
  const evalR = evaluateMarioOperationPolicy({ operation, collected: merged as Record<string, unknown> });

  if (!evalR.readyForPreview) {
    await setMarioDraftOperation(context.tenantId, context.userId, {
      type: operation,
      collected: merged,
      missing: evalR.missingRequired,
    });
    return { proceed: false, result: { intent: "mario_llm_clarification", answer: questionForMissingField(evalR.nextQuestionField), actions: [] } };
  }

  // FASE A.5.2 §3 — somma pax fermate vs totale gruppo: solo se `stops` è
  // stato popolato (multi-stop reale). Il caso a singola origine normalizza
  // sempre stops=[{city:origin, expectedPax:totale}] (somma == totale per
  // costruzione, §1) e quindi non è mai bloccato qui.
  const stopsSumIssue = validateStopsPaxSum(merged);
  if (stopsSumIssue) {
    await setMarioDraftOperation(context.tenantId, context.userId, { type: operation, collected: merged, missing: [] });
    return { proceed: false, result: stopsSumIssue };
  }

  // FASE A.5.1 §1 — idempotenza gruppo: prima di creare, verifica se esiste
  // già (stesso nome + stessa data se nota). Se sì, il gate si ferma qui:
  // nessuna preview_create eseguita, il turno riprende dal DB.
  const reuse = await checkGroupIdempotency(context, operation, merged);
  if (reuse) return { proceed: "reuse", result: reuse.result };

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
  if (classifyMarioOperation({ message }) !== "create_generic_booking_group") return true;
  // FIX A.4.7 — root cause: un messaggio può essere chiaramente una richiesta
  // di creazione (pax + nome/origine/data tutti estraibili) SENZA contenere
  // "bus"/"pullman"/ecc. ("Caricami La Marra, 50 persone, Rimini, 13-20
  // settembre"). Segnale forte = pax numerico ESPLICITO più almeno un altro
  // slot strutturale (nome o origine) — non una singola parola isolata.
  const strongSignal = extractMarioDraftSlotsFromMessage(message, "create_generic_booking_group");
  return Boolean(strongSignal.expectedPax) && Boolean(strongSignal.name || strongSignal.origin);
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
      let draftAmbiguities: string[] | undefined;
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
        // FIX A.4.7 §1/§2 — ambiguità "busMode": un intervallo di date
        // (permanenza multi-giorno, §A.4.5) è di per sé un forte segnale
        // operativo di trasporto anche quando il messaggio non contiene
        // letteralmente "bus" (root cause live: "Caricami La Marra, 50
        // persone, Rimini, 13-20 settembre"). Se non c'è un segnale esplicito
        // esclusivo/condiviso, si salva comunque il draft COMPLETO con
        // un'ambiguità aperta invece di perdere tutto in attesa di chiederla.
        let finalOperation = operation;
        const busModeSignal = resolveBusModeAmbiguity(message);
        const hasRange = Boolean(merged.returnDate);
        let ambiguities: string[] | undefined;
        if (busModeSignal === "exclusive") {
          finalOperation = "create_exclusive_bus_group";
        } else if (busModeSignal === "shared" && finalOperation === "create_exclusive_bus_group") {
          finalOperation = "create_bus_group";
        } else if (hasRange && !busModeSignal) {
          if (finalOperation === "create_generic_booking_group") finalOperation = "create_bus_group";
          if (finalOperation === "create_bus_group") ambiguities = ["busMode"];
        }
        const evalR = evaluateMarioOperationPolicy({ operation: finalOperation, collected: merged });
        await setMarioDraftOperation(context.tenantId, context.userId, {
          type: finalOperation,
          collected: merged,
          missing: evalR.missingRequired,
          ...(ambiguities ? { ambiguities } : {}),
        });
        draftSavedAfter = true;
        draftOperationType = finalOperation;
        draftMissingFields = evalR.missingRequired;
        draftAmbiguities = ambiguities;
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
        ambiguityPresent: Boolean(draftAmbiguities?.length),
        ambiguityCode: draftAmbiguities?.[0],
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
    if (gate.proceed === "reuse") return gate.result;
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
