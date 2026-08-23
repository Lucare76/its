/**
 * Rilevamento Web Speech API (Sprint 6) — separato da app/(app)/mario-assistant/page.tsx
 * cosi' la logica di fallback resta testabile senza jsdom (il repo non lo
 * usa, vedi vitest.config.ts environment:"node" — non introdotto solo per
 * questo sprint, come da istruzione). In ambiente server/test `window` non
 * esiste: la funzione ritorna sempre null li', esattamente il ramo di
 * fallback "browser non supportato".
 */

export type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
