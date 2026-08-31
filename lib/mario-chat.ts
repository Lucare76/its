/**
 * FASE A.2 — helper puri (client+server safe) per la chat Assistente Mario e
 * la card costi. Niente prezzi qui (§8/§15): solo formattazione.
 */

export type MarioChatRole = "user" | "assistant";

export type MarioChatMessage = {
  id: string;
  role: MarioChatRole;
  text: string;
  actions?: Array<{ label: string; href: string }>;
  /** intent della risposta backend (per capire se c'è una conferma in sospeso). */
  intent?: string;
  /** true finché la risposta dell'assistente non è arrivata. */
  pending?: boolean;
  /** true se questo turno assistente è un errore di rete/endpoint. */
  errored?: boolean;
  ts: number;
};

/** L'ultimo turno assistente ha lasciato una conferma in sospeso lato server? */
export function hasPendingConfirmation(messages: MarioChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "assistant" || m.pending) continue;
    return m.intent === "mario_llm_pending_confirmation" || m.intent === "booking_group_inspect";
  }
  return false;
}

/** Mantiene solo gli ultimi `max` messaggi visualizzati (§3). */
export function trimHistory(messages: MarioChatMessage[], max = 30): MarioChatMessage[] {
  return messages.length <= max ? messages : messages.slice(messages.length - max);
}

export function newChatSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * USD leggibile (§9/§14). Importi piccoli con 4–6 decimali significativi,
 * aggregati con 2–4. `null` → null (la UI mostra "costo non configurato").
 */
export function formatUsd(value: number | null | undefined, opts: { compact?: boolean } = {}): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value === 0) return "$0.00";
  const abs = Math.abs(value);
  let decimals: number;
  if (opts.compact) decimals = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  else decimals = abs < 0.001 ? 6 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return `$${value.toFixed(decimals)}`;
}

/** Token con separatore delle migliaia (es. 18.420). */
export function formatTokens(value: number | null | undefined): string {
  const n = Math.max(0, Math.trunc(Number(value ?? 0)));
  return n.toLocaleString("it-IT");
}

export type MarioTurnLlmUsage = {
  llmCalled: boolean;
  calls: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  fallbackUsed: boolean;
};

export type MarioUsageBucket = { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null };

/** Somma il costo di un turno nell'accumulatore di sessione (client-side, §13). */
export function addTurnToSession(session: MarioUsageBucket, turn: MarioTurnLlmUsage | null | undefined): MarioUsageBucket {
  if (!turn || !turn.llmCalled) return session;
  return {
    calls: session.calls + turn.calls,
    inputTokens: session.inputTokens + turn.inputTokens,
    outputTokens: session.outputTokens + turn.outputTokens,
    costUsd:
      turn.costUsd == null
        ? session.costUsd // tariffe non configurate: non inventare un costo
        : (session.costUsd ?? 0) + turn.costUsd,
  };
}

export function emptySessionBucket(): MarioUsageBucket {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}
