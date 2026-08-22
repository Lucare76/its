import { describe, expect, it } from "vitest";
import { evaluateEmailImportRows, type EmailImportHealthRow } from "@/lib/server/operational-health/email-import-health";

const NOW = new Date("2026-08-22T10:00:00.000Z");

function row(overrides: Partial<EmailImportHealthRow>): EmailImportHealthRow {
  return {
    id: "row-1",
    created_at: "2026-08-22T09:00:00.000Z",
    parsed_json: {},
    linked_service: null,
    ...overrides,
  };
}

describe("evaluateEmailImportRows", () => {
  it("9. email senza PDF (nessun pdf_import) -> nessuna anomalia", () => {
    const signals = evaluateEmailImportRows([row({ parsed_json: {} })], NOW);
    expect(signals).toEqual([]);
  });

  it("10. duplicata gestita (import_state skipped_duplicate) -> nessuna anomalia", () => {
    const signals = evaluateEmailImportRows(
      [row({ parsed_json: { pdf_import: { import_state: "skipped_duplicate" } } })],
      NOW
    );
    expect(signals).toEqual([]);
  });

  it("email volutamente ignorata (import_state ignored) -> nessuna anomalia", () => {
    const signals = evaluateEmailImportRows([row({ parsed_json: { pdf_import: { import_state: "ignored" } } })], NOW);
    expect(signals).toEqual([]);
  });

  it("11. import realmente fallito (import_state failed) -> warning", () => {
    const signals = evaluateEmailImportRows(
      [row({ id: "f1", parsed_json: { pdf_import: { import_state: "failed" } } })],
      NOW
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("warning");
    expect(signals[0]!.key).toBe("email:import_failed:f1");
    // Privacy: nessun campo email/mittente nel segnale.
    expect(JSON.stringify(signals[0])).not.toMatch(/@/);
  });

  it("12. review recente (draft/preview) -> info, mai warning (nessuna SLA)", () => {
    const signals = evaluateEmailImportRows(
      [row({ id: "r1", created_at: NOW.toISOString(), parsed_json: { pdf_import: { import_state: "draft" } } })],
      NOW
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("info");
    expect(signals[0]!.key).toBe("email:review_pending");
  });

  it("import confermato (imported) -> nessuna anomalia", () => {
    const signals = evaluateEmailImportRows([row({ parsed_json: { pdf_import: { import_state: "imported" } } })], NOW);
    expect(signals).toEqual([]);
  });
});
