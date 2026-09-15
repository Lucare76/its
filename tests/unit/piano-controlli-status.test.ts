import { describe, it, expect } from "vitest";
import { deriveControlliStatus } from "@/lib/piano-controlli-status";

/**
 * Fix P2 (audit pre-go-live): Controllo Giornata / health cards false-zero.
 * Un fallimento di group-diagnostics non deve mai apparire come "0 problemi".
 */
describe("lib/piano-controlli-status.ts::deriveControlliStatus", () => {
  it("sorgente OK + 0 problemi -> ok", () => {
    expect(deriveControlliStatus(null, 0)).toBe("ok");
  });

  it("sorgente OK + N problemi -> issues", () => {
    expect(deriveControlliStatus(null, 3)).toBe("issues");
  });

  it("sorgente in errore (HTTP 500 / eccezione di rete / payload nullo, tutte mappate sullo stesso errorString) + 0 problemi locali -> error, mai ok", () => {
    expect(deriveControlliStatus("Diagnostica giri non disponibile.", 0)).not.toBe("ok");
    expect(deriveControlliStatus("Diagnostica giri non disponibile.", 0)).toBe("error");
  });

  it("sorgente in errore anche con problemi locali presenti -> error ha priorita' (il dato aggregato non e' affidabile)", () => {
    expect(deriveControlliStatus("Errore rete durante la diagnostica giri.", 2)).toBe("error");
  });

  it("mai 'ok' quando la sorgente e' in errore, indipendentemente dal count", () => {
    expect(deriveControlliStatus("qualsiasi errore", 0)).not.toBe("ok");
    expect(deriveControlliStatus("qualsiasi errore", 5)).not.toBe("ok");
  });

  it("retry/refetch: se la sorgente torna sana lo stato torna corretto (nessuno stato residuo)", () => {
    expect(deriveControlliStatus("errore transitorio", 0)).toBe("error");
    expect(deriveControlliStatus(null, 0)).toBe("ok");
    expect(deriveControlliStatus(null, 1)).toBe("issues");
  });
});
