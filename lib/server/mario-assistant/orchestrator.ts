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
import { detectMarioIntent, UNSUPPORTED_ANSWER, WRITE_UNSUPPORTED_ANSWER } from "./intent-parser";
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
