import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeMedmarReturnMainlandPort,
  readReturnMainlandPort,
  withReturnMainlandPort,
} from "@/lib/medmar-return-port";

// Il percorso email usa il PDF reale Aleste Medmar già presente in
// tests/pdfs (ritorno su Pozzuoli). Per le varianti (ritorno Napoli,
// ritorno senza porto) si sostituisce solo il testo estratto, partendo dallo
// stesso testo reale.
const textOverride = vi.hoisted(() => ({ transform: null as null | ((text: string) => string) }));

vi.mock("@/lib/server/pdf-text", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/pdf-text")>();
  return {
    ...actual,
    extractPdfTextFromBase64: async (base64: string) => {
      const text = await actual.extractPdfTextFromBase64(base64);
      return textOverride.transform ? textOverride.transform(text) : text;
    },
  };
});

const { parseAgencyPdfUpload, buildImportFerryDetails } = await import("@/lib/server/agency-pdf-import");

const ALESTE_MEDMAR_POZZUOLI_PDF = resolve(
  process.cwd(),
  "tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001233_N_26_002905_1_000001.pdf"
);

async function parseAlesteMedmar() {
  return parseAgencyPdfUpload({
    senderEmail: "booking@aleste-viaggi.it",
    subject: "Conferma d'ordine Aleste",
    filename: "conferma.pdf",
    fileBytes: readFileSync(ALESTE_MEDMAR_POZZUOLI_PDF),
  });
}

/** Stesso documento con andata e ritorno su Napoli (formato Aleste "TRAGHETTO NAPOLI"). */
function toNapoli(text: string) {
  return text
    .replace(/TRAGHETTO POZZUOLI/g, "TRAGHETTO NAPOLI")
    .replace("M.p.: PORTO DI POZZUOLI da: POZZUOLI CON MEDMAR", "M.p.: PORTO DI NAPOLI PORTA DI MASSA da: NAPOLI CON MEDMAR")
    .replace(/a: PORTO PER POZZUOLI CON MEDMAR dest:\s*PORTO DI POZZUOLI/, "a: PORTO PER NAPOLI CON MEDMAR dest: PORTO DI NAPOLI");
}

beforeEach(() => {
  textOverride.transform = null;
});

describe("normalizeMedmarReturnMainlandPort — solo valori inequivocabili", () => {
  it("riconosce Napoli e Pozzuoli", () => {
    for (const v of ["PORTO DI NAPOLI", "PORTO DI NAPOLI PORTA DI MASSA", "Porta di Massa", "napoli", "NAPOLI"]) {
      expect(normalizeMedmarReturnMainlandPort(v)).toBe("napoli");
    }
    for (const v of ["PORTO DI POZZUOLI", "pozzuoli", "POZZUOLI"]) {
      expect(normalizeMedmarReturnMainlandPort(v)).toBe("pozzuoli");
    }
  });

  it("C. valori ambigui o non Medmar -> null", () => {
    for (const v of [null, undefined, "", "   ", "NAPOLI BEVERELLO", "Napoli / Pozzuoli", "ISCHIA PORTO", "CASAMICCIOLA", "HOTEL ISCHIA", 42]) {
      expect(normalizeMedmarReturnMainlandPort(v)).toBeNull();
    }
  });

  it("readReturnMainlandPort accetta solo napoli/pozzuoli salvati", () => {
    expect(readReturnMainlandPort({ return_mainland_port: "napoli" })).toBe("napoli");
    expect(readReturnMainlandPort({ return_mainland_port: "pozzuoli" })).toBe("pozzuoli");
    for (const fd of [null, {}, [], "napoli", { return_mainland_port: "NAPOLI" }, { return_mainland_port: "beverello" }]) {
      expect(readReturnMainlandPort(fd)).toBeNull();
    }
  });

  it("D. withReturnMainlandPort preserva le chiavi esistenti e non scrive nulla senza porto", () => {
    const existing = { medmar_adult_count: 2, connection: { kind: "manual" }, arrival_place: "PORTO DI POZZUOLI" };
    expect(withReturnMainlandPort(existing, "pozzuoli")).toEqual({ ...existing, return_mainland_port: "pozzuoli" });
    expect(withReturnMainlandPort(existing, null)).toEqual(existing);
    expect(withReturnMainlandPort(null, null)).toEqual({});
    expect(existing).not.toHaveProperty("return_mainland_port");
  });
});

describe("percorso email (parser deterministico Aleste -> buildNormalizedImport)", () => {
  it("B. PDF reale Aleste Medmar con ritorno Pozzuoli -> return_mainland_port = pozzuoli", async () => {
    const { normalized } = await parseAlesteMedmar();
    expect(normalized.booking_kind).toBe("transfer_port_hotel");
    expect(normalized.return_mainland_port).toBe("pozzuoli");
    expect(buildImportFerryDetails(normalized).return_mainland_port).toBe("pozzuoli");
  });

  it("A. stesso documento con ritorno Napoli -> return_mainland_port = napoli", async () => {
    textOverride.transform = toNapoli;
    const { normalized } = await parseAlesteMedmar();
    expect(normalized.return_mainland_port).toBe("napoli");
    expect(buildImportFerryDetails(normalized).return_mainland_port).toBe("napoli");
  });

  it("C. blocco ritorno senza porto -> nessuna chiave salvata", async () => {
    textOverride.transform = (text) => text.replace(/a: PORTO PER POZZUOLI CON MEDMAR dest:\s*PORTO DI POZZUOLI/, "a: PORTO dest:");
    const { normalized } = await parseAlesteMedmar();
    expect(normalized.return_mainland_port ?? null).toBeNull();
    expect(buildImportFerryDetails(normalized)).not.toHaveProperty("return_mainland_port");
  });

  it("D. ferry_details già popolato sulla bozza: chiavi esistenti preservate, chiavi import aggiornate", async () => {
    const { normalized } = await parseAlesteMedmar();
    const existing = { medmar_adult_count: 2, medmar_child_count: 0, arrival_place: "VECCHIO VALORE" };
    const details = buildImportFerryDetails(normalized, existing);
    expect(details.medmar_adult_count).toBe(2);
    expect(details.medmar_child_count).toBe(0);
    expect(details.arrival_place).toBe(normalized.arrival_place);
    expect(details.return_mainland_port).toBe("pozzuoli");
  });

  it("C. un valore già salvato non viene cancellato da un import che non trova il porto", async () => {
    textOverride.transform = (text) => text.replace(/a: PORTO PER POZZUOLI CON MEDMAR dest:\s*PORTO DI POZZUOLI/, "a: PORTO dest:");
    const { normalized } = await parseAlesteMedmar();
    expect(buildImportFerryDetails(normalized, { return_mainland_port: "pozzuoli" }).return_mainland_port).toBe("pozzuoli");
  });
});
