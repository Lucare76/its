import { describe, it, expect, vi } from "vitest";
import { MARIO_SUGGESTED_QUESTIONS, applySuggestion } from "@/app/(app)/mario-assistant/page";
import { detectMarioIntent } from "@/lib/server/mario-assistant/intent-parser";

describe("MARIO_SUGGESTED_QUESTIONS (spec TEST MINIMI 6)", () => {
  it("contiene almeno le 6 domande richieste dallo sprint", () => {
    const required = [
      "Come siamo messi oggi?",
      "ITS sta funzionando bene?",
      "Cosa richiede attenzione?",
      "Quali servizi sono senza autista?",
      "Chi è disponibile questo pomeriggio?",
      "Chi posso usare dalle 15 alle 20?",
    ];
    for (const question of required) {
      expect(MARIO_SUGGESTED_QUESTIONS).toContain(question);
    }
  });

  it("6. ogni suggerimento corrisponde SOLO a un intent realmente supportato dal parser reale — mai 'unsupported'/'write_unsupported'", () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    for (const question of MARIO_SUGGESTED_QUESTIONS) {
      const { intent } = detectMarioIntent(question, now);
      expect(intent, `"${question}" -> ${intent}`).not.toBe("unsupported");
      expect(intent, `"${question}" -> ${intent}`).not.toBe("write_unsupported");
    }
  });

  it("nessun duplicato nella lista suggerimenti", () => {
    expect(new Set(MARIO_SUGGESTED_QUESTIONS).size).toBe(MARIO_SUGGESTED_QUESTIONS.length);
  });
});

describe("applySuggestion (spec TEST MINIMI 7 — click valorizza input, mai invio automatico)", () => {
  it("7. chiama SOLO setMessage con la frase esatta, nessun altro effetto", () => {
    const setMessage = vi.fn();
    applySuggestion("Come siamo messi oggi?", setMessage);
    expect(setMessage).toHaveBeenCalledTimes(1);
    expect(setMessage).toHaveBeenCalledWith("Come siamo messi oggi?");
  });

  it("non chiama alcuna funzione di invio (contratto: applySuggestion accetta solo setMessage, non puo' invocare un send)", () => {
    // applySuggestion ha tipo (suggestion: string, setMessage: (v: string) => void) => void:
    // non riceve mai un riferimento a handleSend, quindi non puo' strutturalmente
    // dichiarare un invio automatico — verificato qui passando una spy che
    // rileva se viene chiamata con qualunque argomento diverso dalla stringa.
    const calls: unknown[] = [];
    applySuggestion("Chi è disponibile questo pomeriggio?", (v) => calls.push(v));
    expect(calls).toEqual(["Chi è disponibile questo pomeriggio?"]);
  });
});
