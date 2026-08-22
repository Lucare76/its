import { describe, expect, it } from "vitest";
import { evaluateBackupPayload, BACKUP_EXPECTED_TABLES } from "@/lib/server/operational-health/backup-health";

const NOW = "2026-08-22T10:00:00.000Z";

function validPayload(overrides: Partial<{ generated_at: string; data: Record<string, unknown[]> }> = {}) {
  const data: Record<string, unknown[]> = {};
  for (const table of BACKUP_EXPECTED_TABLES) data[table] = [];
  return {
    generated_at: overrides.generated_at ?? NOW,
    tables: [...BACKUP_EXPECTED_TABLES],
    row_counts: Object.fromEntries(BACKUP_EXPECTED_TABLES.map((t) => [t, 0])),
    data: { ...data, ...(overrides.data ?? {}) },
  };
}

describe("evaluateBackupPayload", () => {
  it("1. backup valido -> nessun segnale (healthy)", () => {
    const payload = validPayload();
    const signals = evaluateBackupPayload(payload, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    expect(signals).toEqual([]);
  });

  it("2. JSON invalido (root non oggetto) -> critical", () => {
    const signals = evaluateBackupPayload("not an object", { filename: "backup_2026-08-22.json", detectedAt: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("critical");
    expect(signals[0]!.key).toBe("backup:invalid_root");
  });

  it("3. tabella essenziale mancante -> critical", () => {
    const payload = validPayload();
    delete (payload.data as Record<string, unknown>).services;
    const signals = evaluateBackupPayload(payload, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    const missing = signals.find((s) => s.key === "backup:missing_tables");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("critical");
    expect(missing!.metadata?.missing_tables).toEqual(["services"]);
  });

  it("4. tabella legittimamente vuota -> non e' un'anomalia", () => {
    const payload = validPayload({ data: { services: [] } });
    const signals = evaluateBackupPayload(payload, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    expect(signals.find((s) => s.key.includes("services"))).toBeUndefined();
    expect(signals).toEqual([]);
  });

  it("tabella con struttura non valida (non array) -> critical", () => {
    const payload = validPayload({ data: { services: { not: "an array" } as unknown as unknown[] } });
    const signals = evaluateBackupPayload(payload, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    const corrupt = signals.find((s) => s.key === "backup:corrupt_tables");
    expect(corrupt).toBeDefined();
    expect(corrupt!.severity).toBe("critical");
  });

  it("sezione data mancante -> critical", () => {
    const signals = evaluateBackupPayload({ generated_at: NOW }, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.key).toBe("backup:missing_data_section");
  });

  it("errori di esportazione registrati nel file (senza tabelle mancanti/corrotte) -> warning", () => {
    const payload = validPayload({ generated_at: NOW }) as ReturnType<typeof validPayload> & { errors: string[] };
    payload.errors = ["agencies: timeout"];
    const signals = evaluateBackupPayload(payload, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.key).toBe("backup:export_errors_recorded");
    expect(signals[0]!.severity).toBe("warning");
  });

  it("generated_at mancante -> warning (verifica non conclusiva)", () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).generated_at;
    const signals = evaluateBackupPayload(payload, { filename: "backup_2026-08-22.json", detectedAt: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.key).toBe("backup:missing_metadata");
    expect(signals[0]!.severity).toBe("warning");
  });
});
