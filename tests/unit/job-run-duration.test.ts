import { describe, it, expect } from "vitest";
import { formatJobRunDuration } from "@/lib/job-run-duration";

/**
 * Regressione "durata 0s" (DR V3, FASE 1, 2026-09-13): il job "postgres-backup"
 * viene riportato a lavoro gia' concluso (GitHub Actions -> POST di report), per
 * cui started_at/finished_at su system_job_runs sono quasi simultanei. La durata
 * reale deve venire da metadata.duration_ms quando presente.
 */
describe("formatJobRunDuration", () => {
  it("metadata.duration_ms=36893 -> '37s' (arrotondato), anche se started_at/finished_at coincidono", () => {
    const startedAt = "2026-09-13T02:30:00.000Z";
    const finishedAt = "2026-09-13T02:30:00.010Z"; // ~10ms di delta reale nel DB (report post-hoc)
    expect(formatJobRunDuration(startedAt, finishedAt, { duration_ms: 36893 })).toBe("37s");
  });

  it("metadata.duration_ms=999 -> '1s' (Math.round, coerente con l'helper esistente)", () => {
    const startedAt = "2026-09-13T02:30:00.000Z";
    const finishedAt = "2026-09-13T02:30:00.000Z";
    expect(formatJobRunDuration(startedAt, finishedAt, { duration_ms: 999 })).toBe("1s");
  });

  it("metadata.duration_ms >= 60000 -> formato 'Nm Ss'", () => {
    const startedAt = "2026-09-13T02:30:00.000Z";
    const finishedAt = "2026-09-13T02:30:00.000Z";
    expect(formatJobRunDuration(startedAt, finishedAt, { duration_ms: 125_000 })).toBe("2m 5s");
  });

  it("metadata assente (job 'normali': backup JSON, whatsapp-reminders) -> fallback al delta started_at/finished_at, comportamento invariato", () => {
    const startedAt = "2026-09-13T02:30:00.000Z";
    const finishedAt = "2026-09-13T02:30:05.000Z";
    expect(formatJobRunDuration(startedAt, finishedAt)).toBe("5s");
    expect(formatJobRunDuration(startedAt, finishedAt, {})).toBe("5s");
  });

  it("metadata.duration_ms non numerico o negativo -> ignorato, fallback al delta timestamp", () => {
    const startedAt = "2026-09-13T02:30:00.000Z";
    const finishedAt = "2026-09-13T02:30:03.000Z";
    expect(formatJobRunDuration(startedAt, finishedAt, { duration_ms: "not-a-number" })).toBe("3s");
    expect(formatJobRunDuration(startedAt, finishedAt, { duration_ms: -50 })).toBe("3s");
    expect(formatJobRunDuration(startedAt, finishedAt, { duration_ms: null })).toBe("3s");
  });

  it("finishedAt null -> 'in corso' (run ancora in esecuzione, indipendentemente da metadata)", () => {
    expect(formatJobRunDuration("2026-09-13T02:30:00.000Z", null)).toBe("in corso");
    expect(formatJobRunDuration("2026-09-13T02:30:00.000Z", null, { duration_ms: 5000 })).toBe("in corso");
  });

  it("delta timestamp negativo/invalido (nessun duration_ms) -> '—'", () => {
    const startedAt = "2026-09-13T02:30:05.000Z";
    const finishedAt = "2026-09-13T02:30:00.000Z"; // finished prima di started: dato incoerente
    expect(formatJobRunDuration(startedAt, finishedAt)).toBe("—");
  });

  it("il vero bug osservato: started_at===finished_at (report post-hoc) senza duration_ms -> '0s' (root cause riprodotta)", () => {
    const iso = "2026-09-13T02:30:00.000Z";
    expect(formatJobRunDuration(iso, iso)).toBe("0s");
  });
});
