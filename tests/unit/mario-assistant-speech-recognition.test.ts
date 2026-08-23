import { describe, it, expect } from "vitest";
import { getSpeechRecognitionCtor } from "@/lib/mario-speech-recognition";

describe("getSpeechRecognitionCtor (spec TEST MINIMI — UI/voice)", () => {
  it("23. ambiente senza window (no jsdom in questo repo) -> null, stesso ramo del browser non supportato", () => {
    expect(typeof window).toBe("undefined");
    expect(getSpeechRecognitionCtor()).toBeNull();
  });
});
