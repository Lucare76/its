"use client";

/**
 * Mario Assistant — FASE A.2: chat operativa multi-turno + card costi LLM.
 *
 * - Conversazione user/assistant in stato React locale (§3: nessuna memoria
 *   chat permanente; il contesto operativo vive già in Redis lato server).
 * - Ogni messaggio passa SEMPRE da POST /api/mario-assistant → orchestrator →
 *   MCP (preview → conferma → write invariati). Le CTA "Conferma"/"Annulla"
 *   inviano solo testo ("Confermo" / "Annulla") sullo stesso endpoint (§5).
 * - Card costi: token/costo dell'ultima richiesta dalla risposta POST (`llm`),
 *   aggregati oggi/mese da GET /api/mario-assistant/usage-summary (§12/§14).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, SectionCard, EmptyState } from "@/components/ui";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from "@/lib/mario-speech-recognition";
import {
  addTurnToSession,
  emptySessionBucket,
  formatTokens,
  formatUsd,
  hasPendingConfirmation,
  newChatSessionId,
  trimHistory,
  type MarioChatMessage,
  type MarioTurnLlmUsage,
  type MarioUsageBucket,
} from "@/lib/mario-chat";

type MarioAction = { label: string; href: string };
type MarioResponse = {
  ok: boolean;
  intent?: string;
  answer?: string;
  actions?: MarioAction[];
  llm?: MarioTurnLlmUsage | null;
  error?: string;
};

type UsageSummary = {
  ok: boolean;
  pricingConfigured: boolean;
  unavailable?: boolean;
  lastRequest:
    | { createdAt: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null; fallbackUsed: boolean; failed: boolean }
    | null;
  today: MarioUsageBucket;
  month: MarioUsageBucket;
};

/**
 * Esempi cliccabili — coerenti SOLO con gli intent realmente supportati dal
 * parser (vedi tests/unit/mario-assistant-suggestions.test.ts).
 */
export const MARIO_SUGGESTED_QUESTIONS: string[] = [
  "Come siamo messi oggi?",
  "ITS sta funzionando bene?",
  "Cosa richiede attenzione?",
  "Quali servizi sono senza autista?",
  "Chi è disponibile questo pomeriggio?",
  "Chi posso usare dalle 15 alle 20?",
];

/** Logica del click su un suggerimento: valorizza SOLO l'input, mai un invio automatico. */
export function applySuggestion(suggestion: string, setMessage: (value: string) => void) {
  setMessage(suggestion);
}

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `m${Date.now().toString(36)}-${msgSeq}`;
}

export default function MarioAssistantPage() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MarioChatMessage[]>([]);
  const [session, setSession] = useState<MarioUsageBucket>(() => emptySessionBucket());
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) sessionIdRef.current = newChatSessionId();

  const speechSupported = getSpeechRecognitionCtor() !== null;
  const pendingConfirmation = useMemo(() => hasPendingConfirmation(messages), [messages]);

  const refreshSummary = useCallback(async () => {
    try {
      const s = await getClientSessionContext();
      if (!s.accessToken) return;
      const res = await fetch("/api/mario-assistant/usage-summary", {
        headers: { authorization: `Bearer ${s.accessToken}` },
      });
      if (!res.ok) return;
      setSummary((await res.json()) as UsageSummary);
    } catch {
      /* la card costi è osservabilità: un errore qui non tocca la chat */
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || loading) return;

      const userMsg: MarioChatMessage = { id: nextMsgId(), role: "user", text, ts: Date.now() };
      const pendingMsg: MarioChatMessage = { id: nextMsgId(), role: "assistant", text: "", pending: true, ts: Date.now() };
      setMessages((prev) => trimHistory([...prev, userMsg, pendingMsg]));
      setLoading(true);
      setError(null);

      try {
        const s = await getClientSessionContext();
        if (!s.accessToken) {
          setMessages((prev) => prev.filter((m) => m.id !== pendingMsg.id));
          setError("Login richiesto.");
          setLoading(false);
          return;
        }

        const res = await fetch("/api/mario-assistant", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${s.accessToken}` },
          body: JSON.stringify({ message: text }),
        });

        if (!res.ok) {
          const msg =
            res.status === 401
              ? "Login richiesto."
              : res.status === 403
                ? "Il tuo ruolo non può usare Mario Assistant."
                : res.status === 429
                  ? "Troppe richieste, riprova tra poco."
                  : "Al momento non riesco a rispondere. Riprova.";
          setMessages((prev) =>
            prev.map((m) => (m.id === pendingMsg.id ? { ...m, pending: false, errored: true, text: msg } : m)),
          );
          setError(msg);
          return; // input NON svuotato: l'utente può ritentare
        }

        const data = (await res.json()) as MarioResponse;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingMsg.id
              ? {
                  ...m,
                  pending: false,
                  text: data.answer ?? "(nessuna risposta)",
                  actions: data.actions ?? [],
                  intent: data.intent,
                }
              : m,
          ),
        );
        setMessage(""); // successo: pulisci l'input
        if (data.llm) setSession((prev) => addTurnToSession(prev, data.llm ?? undefined));
        void refreshSummary();
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingMsg.id
              ? { ...m, pending: false, errored: true, text: "Al momento non riesco a rispondere. Riprova." }
              : m,
          ),
        );
        setError("Al momento non riesco a rispondere. Riprova.");
      } finally {
        setLoading(false);
      }
    },
    [loading, refreshSummary],
  );

  const handleMicClick = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("Il riconoscimento vocale non è supportato da questo browser. Usa il campo di testo.");
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "it-IT";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) setMessage(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [listening]);

  const usdOrNull = (v: number | null | undefined, compact = true) => formatUsd(v, { compact });
  const pricingOff = summary != null && !summary.pricingConfigured;

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Mario Assistant"
          subtitle="Chiedi in linguaggio naturale — situazione della giornata, alert, autisti, o crea/aggiorna un gruppo prenotazione (sempre con anteprima e conferma)."
        />
        <UsageCard summary={summary} session={session} pricingOff={pricingOff} fmt={usdOrNull} />
      </div>

      <SectionCard>
        <div className="flex min-h-[42vh] flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  Puoi chiedermi della situazione della giornata, salute del sistema, alert, servizi non assegnati e
                  disponibilità autisti — oppure di creare un gruppo prenotazione.
                </p>
                <div className="flex flex-wrap gap-2">
                  {MARIO_SUGGESTED_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => applySuggestion(q, setMessage)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => <ChatBubble key={m.id} message={m} />)
            )}
          </div>

          {pendingConfirmation ? (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => void send("Confermo")}
                disabled={loading}
                className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Conferma
              </button>
              <button
                type="button"
                onClick={() => void send("Annulla")}
                disabled={loading}
                className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Annulla
              </button>
              <span className="self-center text-xs text-muted">…oppure scrivi la tua risposta qui sotto.</span>
            </div>
          ) : null}

          <div className="mt-3 flex items-end gap-2 border-t border-slate-200 pt-3">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(message);
                }
              }}
              rows={1}
              placeholder="Scrivi un messaggio…  (Invio = invia, Shift+Invio = a capo)"
              className="min-h-[42px] max-h-40 min-w-0 flex-1 resize-y rounded-md border border-slate-300 px-3 py-2 text-sm"
              aria-label="Messaggio per Mario Assistant"
              disabled={loading}
            />
            <button
              type="button"
              onClick={handleMicClick}
              aria-pressed={listening}
              title={speechSupported ? "Usa il microfono" : "Riconoscimento vocale non supportato da questo browser"}
              className={`rounded-md border px-3 py-2 text-sm font-medium ${
                listening ? "border-rose-300 bg-rose-50 text-rose-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {listening ? "🎤…" : "🎤"}
            </button>
            <button
              type="button"
              onClick={() => void send(message)}
              disabled={loading || !message.trim()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loading ? "…" : "Invia"}
            </button>
          </div>

          {loading ? <p className="mt-2 text-xs text-muted">Mario sta elaborando…</p> : null}
          {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
          {!speechSupported ? (
            <p className="mt-1 text-xs text-muted">Riconoscimento vocale non disponibile in questo browser — usa il campo di testo.</p>
          ) : null}
        </div>
      </SectionCard>

      {messages.length === 0 && error ? <EmptyState title="Non riesco a rispondere" description={error} /> : null}
    </div>
  );
}

function ChatBubble({ message }: { message: MarioChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-slate-900 text-white"
            : message.errored
              ? "border border-rose-200 bg-rose-50 text-rose-700"
              : "border border-slate-200 bg-white text-text"
        }`}
      >
        {message.pending ? (
          <span className="inline-flex items-center gap-1 text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
            Mario sta elaborando…
          </span>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
            {message.actions && message.actions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.actions.map((a) => (
                  <a
                    key={`${a.label}-${a.href}`}
                    href={a.href}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {a.label}
                  </a>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function UsageCard({
  summary,
  session,
  pricingOff,
  fmt,
}: {
  summary: UsageSummary | null;
  session: MarioUsageBucket;
  pricingOff: boolean;
  fmt: (v: number | null | undefined, compact?: boolean) => string | null;
}) {
  const today = summary?.today;
  const month = summary?.month;
  const last = summary?.lastRequest;

  const line = (calls: number, tokens: number, cost: number | null | undefined) => {
    const costStr = pricingOff || cost == null ? "costo non configurato" : fmt(cost, false);
    return `${calls} chiamate AI · ${formatTokens(tokens)} token · ${costStr}`;
  };

  return (
    <div className="w-full max-w-xs shrink-0 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
      <div className="mb-1 font-semibold text-slate-700">Uso AI</div>
      <div className="space-y-1">
        <div>
          <span className="text-muted">Oggi:</span>{" "}
          {today ? line(today.calls, today.inputTokens + today.outputTokens, today.costUsd) : "—"}
        </div>
        <div>
          <span className="text-muted">Mese:</span>{" "}
          {month ? line(month.calls, month.inputTokens + month.outputTokens, month.costUsd) : "—"}
        </div>
        <div>
          <span className="text-muted">Sessione:</span>{" "}
          {line(session.calls, session.inputTokens + session.outputTokens, session.costUsd)}
        </div>
        <div>
          <span className="text-muted">Ultima:</span>{" "}
          {last
            ? `${formatTokens(last.inputTokens)} in / ${formatTokens(last.outputTokens)} out · ${
                pricingOff || last.costUsd == null ? "costo non configurato" : fmt(last.costUsd, false)
              }${last.fallbackUsed ? " · fallback" : ""}`
            : "nessuna chiamata AI"}
        </div>
      </div>
    </div>
  );
}
