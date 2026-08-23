"use client";

/**
 * Mario Assistant (Sprint 6) — interfaccia one-shot testo + voce per
 * interrogare ITS in linguaggio naturale, tramite /api/mario-assistant
 * (che a sua volta chiama i tool MCP READ Sprint 5). Nessuna chat
 * multi-turn: una domanda, una risposta.
 */
import { useCallback, useRef, useState } from "react";
import { PageHeader, SectionCard, EmptyState } from "@/components/ui";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from "@/lib/mario-speech-recognition";

type MarioAction = { label: string; href: string };
type MarioResponse = {
  ok: boolean;
  intent?: string;
  answer?: string;
  actions?: MarioAction[];
  error?: string;
};

/**
 * Esempi cliccabili — coerenti SOLO con gli intent realmente supportati da
 * lib/server/mario-assistant/intent-parser.ts (vedi tests/unit/mario-assistant-suggestions.test.ts,
 * che verifica ogni frase contro il parser reale). Costante locale semplice:
 * il parser vive in lib/server/ (solo server), non importabile qui senza
 * portare codice server-only nel bundle client — vedi nota "source of
 * truth" nello sprint, refactor non necessario per 6 frasi stabili.
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

export default function MarioAssistantPage() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<MarioResponse | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const speechSupported = getSpeechRecognitionCtor() !== null;

  const handleSend = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const session = await getClientSessionContext();
      if (!session.accessToken) {
        setError("Login richiesto.");
        setLoading(false);
        return;
      }

      const res = await fetch("/api/mario-assistant", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!res.ok) {
        if (res.status === 401) setError("Login richiesto.");
        else if (res.status === 403) setError("Il tuo ruolo non può usare Mario Assistant.");
        else if (res.status === 429) setError("Troppe richieste, riprova tra poco.");
        else setError("Al momento non riesco a rispondere. Riprova.");
        setLoading(false);
        return;
      }

      const data = (await res.json()) as MarioResponse;
      setResponse(data);
    } catch {
      setError("Al momento non riesco a rispondere. Riprova.");
    } finally {
      setLoading(false);
    }
  }, [message]);

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

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="Mario Assistant"
        subtitle="Fai una domanda su ITS in linguaggio naturale — situazione della giornata, salute sistema, alert, servizi senza autista, disponibilità autisti."
      />

      <SectionCard>
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) void handleSend();
              }}
              placeholder="Es: come siamo messi oggi?"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              aria-label="Domanda per Mario Assistant"
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
              {listening ? "🎤 Ascolto…" : "🎤"}
            </button>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={loading || !message.trim()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loading ? "Invio…" : "Invia"}
            </button>
          </div>
          {!speechSupported ? (
            <p className="text-xs text-muted">Riconoscimento vocale non disponibile in questo browser — usa il campo di testo.</p>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Puoi chiedermi…">
        <div className="space-y-2">
          <p className="text-sm text-muted">
            Puoi chiedermi della situazione della giornata, salute del sistema, alert, servizi non assegnati e
            disponibilità autisti.
          </p>
          <div className="flex flex-wrap gap-2">
            {MARIO_SUGGESTED_QUESTIONS.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => applySuggestion(question, setMessage)}
                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      </SectionCard>

      {error ? (
        <EmptyState title="Non riesco a rispondere" description={error} />
      ) : null}

      {response ? (
        <SectionCard title="Risposta">
          <div className="space-y-3">
            <p className="whitespace-pre-line text-sm text-text">{response.answer}</p>
            {response.actions && response.actions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {response.actions.map((action) => (
                  <a
                    key={`${action.label}-${action.href}`}
                    href={action.href}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {action.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
