import { describe, expect, it } from "vitest";
import { evaluateJobHealth, computeOverallHealth, summarizeJobHealthCounts, type JobHealthEvaluation } from "@/lib/server/job-health-evaluator";
import { JOB_HEALTH_CONFIG, type JobHealthRuleConfig } from "@/lib/server/job-health-config";
import type { SystemJobRunRow } from "@/lib/server/job-health";

const NOW = new Date("2026-08-22T10:00:00.000Z");

function makeConfig(overrides: Partial<JobHealthRuleConfig> = {}): JobHealthRuleConfig {
  return {
    jobKey: "backup",
    jobName: "Backup automatico",
    enabled: true,
    schedulingMode: "scheduled",
    expectedCadence: "daily",
    cadenceLabel: "Ogni giorno alle 02:00",
    staleAfterMinutes: 26 * 60,
    maxRunningMinutes: 15,
    criticalConsecutiveFailures: 3,
    missingRunSeverity: "warning",
    staleSeverity: "critical",
    ...overrides,
  };
}

function makeRun(overrides: Partial<SystemJobRunRow> = {}): SystemJobRunRow {
  return {
    id: "run-1",
    tenant_id: "tenant-1",
    job_key: "backup",
    job_name: "Backup automatico",
    source: "api/cron/backup",
    started_at: "2026-08-22T02:00:00.000Z",
    finished_at: "2026-08-22T02:01:00.000Z",
    status: "success",
    processed_count: 12,
    success_count: 12,
    failed_count: 0,
    warning_count: 0,
    error_message: null,
    metadata: {},
    created_at: "2026-08-22T02:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateJobHealth — 1. job success sano", () => {
  it("run success recente, entro finestra -> healthy", () => {
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [makeRun()], now: NOW });
    expect(evaluation.healthStatus).toBe("healthy");
    expect(evaluation.reason).toBe("Backup completato correttamente.");
  });
});

describe("evaluateJobHealth — 2. job failed", () => {
  it("ultima esecuzione fallita, sotto soglia critica -> warning con motivo comprensibile", () => {
    const runs = [makeRun({ id: "r2", status: "failed", started_at: "2026-08-22T02:00:00.000Z", error_message: "connessione rifiutata" })];
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toBe("Ultima esecuzione fallita.");
    expect(evaluation.technicalDetail).toBe("connessione rifiutata");
  });
});

describe("evaluateJobHealth — 3. fallimenti consecutivi", () => {
  it("3 fallimenti consecutivi (soglia default) -> critical", () => {
    const runs = [
      makeRun({ id: "r3", status: "failed", started_at: "2026-08-22T02:00:00.000Z" }),
      makeRun({ id: "r2", status: "failed", started_at: "2026-08-21T02:00:00.000Z" }),
      makeRun({ id: "r1", status: "failed", started_at: "2026-08-20T02:00:00.000Z" }),
    ];
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("critical");
    expect(evaluation.consecutiveFailures).toBe(3);
    expect(evaluation.reason).toBe("3 esecuzioni consecutive fallite.");
  });

  it("2 fallimenti consecutivi (sotto soglia 3) -> warning, non critical", () => {
    const runs = [
      makeRun({ id: "r2", status: "failed", started_at: "2026-08-22T02:00:00.000Z" }),
      makeRun({ id: "r1", status: "failed", started_at: "2026-08-21T02:00:00.000Z" }),
    ];
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.consecutiveFailures).toBe(2);
  });
});

describe("evaluateJobHealth — 4. run stale", () => {
  it("ultimo successo oltre staleAfterMinutes -> health = staleSeverity (critical per default)", () => {
    const runs = [makeRun({ id: "old", started_at: "2026-08-20T02:00:00.000Z", finished_at: "2026-08-20T02:01:00.000Z" })]; // ~56h prima di NOW, oltre 26h
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.stale).toBe(true);
    expect(evaluation.healthStatus).toBe("critical");
    expect(evaluation.reason).toBe("Ultimo successo troppo vecchio.");
  });

  it("staleSeverity configurabile a 'warning' -> health warning invece di critical", () => {
    const runs = [makeRun({ id: "old", started_at: "2026-08-20T02:00:00.000Z", finished_at: "2026-08-20T02:01:00.000Z" })];
    const evaluation = evaluateJobHealth({ config: makeConfig({ staleSeverity: "warning" }), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
  });
});

describe("evaluateJobHealth — 5. run 'running' bloccato", () => {
  it("running da oltre maxRunningMinutes -> critical, stuck=true", () => {
    const runs = [makeRun({ id: "stuck", status: "running", finished_at: null, started_at: "2026-08-22T09:30:00.000Z" })]; // 30 min prima di NOW, soglia 15
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("critical");
    expect(evaluation.stuck).toBe(true);
    expect(evaluation.reason).toContain("fermo in esecuzione");
  });

  it("running da meno di maxRunningMinutes -> non critical/stuck (esecuzione in corso, osservabilita' pura)", () => {
    const runs = [makeRun({ id: "running", status: "running", finished_at: null, started_at: "2026-08-22T09:55:00.000Z" })]; // 5 min prima, soglia 15
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.stuck).toBe(false);
    expect(evaluation.healthStatus).not.toBe("critical");
  });
});

describe("evaluateJobHealth — 6. job enabled mai eseguito ma non ancora atteso", () => {
  it("nessun run, nessun firstExpectedAt configurato -> unknown, MAI warning", () => {
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [], now: NOW });
    expect(evaluation.healthStatus).toBe("unknown");
  });

  it("nessun run, firstExpectedAt nel futuro -> ancora unknown (finestra non ancora superata)", () => {
    const evaluation = evaluateJobHealth({ config: makeConfig({ firstExpectedAt: "2026-08-23T00:00:00.000Z" }), runs: [], now: NOW });
    expect(evaluation.healthStatus).toBe("unknown");
  });
});

describe("evaluateJobHealth — 7. job enabled mai eseguito e finestra superata", () => {
  it("nessun run, firstExpectedAt nel passato -> severita' da missingRunSeverity (default warning)", () => {
    const evaluation = evaluateJobHealth({ config: makeConfig({ firstExpectedAt: "2026-08-21T00:00:00.000Z" }), runs: [], now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toBe("Esecuzione attesa ma non rilevata.");
  });

  it("missingRunSeverity 'critical' configurabile", () => {
    const evaluation = evaluateJobHealth({
      config: makeConfig({ firstExpectedAt: "2026-08-21T00:00:00.000Z", missingRunSeverity: "critical" }),
      runs: [],
      now: NOW,
    });
    expect(evaluation.healthStatus).toBe("critical");
  });
});

describe("evaluateJobHealth — 8. job disabled", () => {
  it("enabled=false -> sempre 'disabled', indipendentemente dai run", () => {
    const runs = [makeRun({ status: "failed" }), makeRun({ status: "failed" }), makeRun({ status: "failed" })];
    const evaluation = evaluateJobHealth({ config: makeConfig({ enabled: false }), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("disabled");
    expect(evaluation.enabled).toBe(false);
  });
});

describe("evaluateJobHealth — 9. poll-emails con skipped_no_pdf > 0 resta sano", () => {
  it("execution status=success, warning_count=1 (solo email senza PDF) -> health=healthy, non warning", () => {
    const run = makeRun({
      job_key: "poll-emails",
      status: "success",
      started_at: "2026-08-22T09:50:00.000Z",
      finished_at: "2026-08-22T09:50:30.000Z",
      warning_count: 1,
      metadata: { emails_processed: 1, skipped_no_pdf: 1, drafts_created: 0, duplicate_warnings: 0 },
    });
    const evaluation = evaluateJobHealth({
      config: makeConfig({ jobKey: "poll-emails", jobName: "Polling email", staleAfterMinutes: 3 * 60 }),
      runs: [run],
      now: NOW,
    });
    expect(evaluation.healthStatus).toBe("healthy");
    expect(evaluation.notes).toContain("1 email senza PDF");
  });

  it("mailbox vuota (0 email processate) resta comunque sana", () => {
    const run = makeRun({
      job_key: "poll-emails",
      status: "success",
      started_at: "2026-08-22T09:50:00.000Z",
      finished_at: "2026-08-22T09:50:30.000Z",
      warning_count: 0,
      metadata: { emails_processed: 0, drafts_created: 0 },
    });
    const evaluation = evaluateJobHealth({
      config: makeConfig({ jobKey: "poll-emails", jobName: "Polling email", staleAfterMinutes: 3 * 60 }),
      runs: [run],
      now: NOW,
    });
    expect(evaluation.healthStatus).toBe("healthy");
  });
});

describe("evaluateJobHealth — 10. backup con errori parziali diventa warning", () => {
  it("run success ma con table_errors -> health=warning, motivo comprensibile", () => {
    const run = makeRun({ status: "warning", metadata: { table_errors: ["services: timeout"], tables_exported: 11 } });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toContain("tabelle con errori");
  });

  it("purge fallito ma backup principale creato -> warning", () => {
    const run = makeRun({ status: "warning", metadata: { purge_errors: ["remove failed"], tables_exported: 12 } });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toContain("pulizia backup vecchi non riuscita");
  });
});

describe("evaluateJobHealth — 10b. Disaster Recovery V2, copia offsite R2 (primario non deve mai risultare invalidato da un problema R2)", () => {
  it("primary success + offsite success + HeadObject verificato -> healthy, con nota offsite", () => {
    const run = makeRun({
      status: "success",
      metadata: {
        tables_exported: 24,
        offsite_backup: { provider: "cloudflare-r2", bucket: "its-backups-offsite", key: "production/backup_2026-08-22.json", status: "success", size_bytes: 123, verified: true },
      },
    });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("healthy");
    expect(evaluation.notes).toContain("copia offsite (R2) verificata");
  });

  it("primary success ma offsite failed -> warning (mai critical/failed), backup primario resta implicitamente riuscito", () => {
    const run = makeRun({
      status: "warning",
      metadata: {
        tables_exported: 24,
        offsite_backup: { provider: "cloudflare-r2", status: "failed", error: "PutObject error" },
      },
    });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toContain("copia offsite (R2) non riuscita");
  });

  it("env R2 mancanti (offsite skipped) -> warning con motivo esplicito 'non configurata'", () => {
    const run = makeRun({
      status: "warning",
      metadata: {
        tables_exported: 24,
        offsite_backup: { provider: "cloudflare-r2", status: "skipped", error: "Variabili R2 mancanti: R2_ENDPOINT" },
      },
    });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toContain("copia offsite (R2) non configurata");
  });

  it("purge R2 fallito ma offsite_backup success -> warning per la pulizia, non per l'upload", () => {
    const run = makeRun({
      status: "warning",
      metadata: {
        tables_exported: 24,
        offsite_backup: { provider: "cloudflare-r2", status: "success", verified: true },
        offsite_purge_errors: ["Cancellazione oggetti R2 fallita: boom"],
      },
    });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
    expect(evaluation.reason).toContain("pulizia offsite (R2) non riuscita");
  });

  it("run pre-Disaster-Recovery-V2 (nessun campo offsite_backup in metadata) -> comportamento identico a prima, nessuna nota offsite", () => {
    const run = makeRun({ status: "success", metadata: { tables_exported: 12 } });
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs: [run], now: NOW });
    expect(evaluation.healthStatus).toBe("healthy");
    expect(evaluation.notes).not.toContain("copia offsite (R2) verificata");
  });
});

describe("evaluateJobHealth — 11. ultimo failed seguito da success torna sano", () => {
  it("1 fallimento isolato PRIMA di un success piu' recente -> healthy (il piu' recente vince)", () => {
    const runs = [
      makeRun({ id: "recent-success", status: "success", started_at: "2026-08-22T02:00:00.000Z", finished_at: "2026-08-22T02:01:00.000Z" }),
      makeRun({ id: "old-failure", status: "failed", started_at: "2026-08-21T02:00:00.000Z" }),
    ];
    const evaluation = evaluateJobHealth({ config: makeConfig(), runs, now: NOW });
    expect(evaluation.healthStatus).toBe("healthy");
    expect(evaluation.consecutiveFailures).toBe(0);
  });
});

describe("computeOverallHealth — 12/13. stato generale e contributo dei job disabled", () => {
  function makeEvaluation(overrides: Partial<JobHealthEvaluation> = {}): JobHealthEvaluation {
    return {
      jobKey: "x",
      jobName: "X",
      enabled: true,
      healthStatus: "healthy",
      reason: "",
      technicalDetail: null,
      lastRun: null,
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0,
      recentWarningCount: 0,
      stale: false,
      stuck: false,
      notes: [],
      ...overrides,
    };
  }

  it("12. un job disabled con esecuzioni fallite NON contribuisce allo stato generale", () => {
    const evaluations = [
      makeEvaluation({ jobKey: "a", healthStatus: "healthy" }),
      makeEvaluation({ jobKey: "b", healthStatus: "disabled", enabled: false }),
    ];
    expect(computeOverallHealth(evaluations)).toBe("healthy");
  });

  it("13a. tutti healthy -> overall healthy", () => {
    expect(computeOverallHealth([makeEvaluation({ healthStatus: "healthy" }), makeEvaluation({ healthStatus: "unknown" })])).toBe("healthy");
  });

  it("13b. almeno un warning, nessun critical -> attention", () => {
    expect(computeOverallHealth([makeEvaluation({ healthStatus: "healthy" }), makeEvaluation({ healthStatus: "warning" })])).toBe("attention");
  });

  it("13c. almeno un critical -> critical, anche con warning presenti", () => {
    expect(computeOverallHealth([makeEvaluation({ healthStatus: "warning" }), makeEvaluation({ healthStatus: "critical" })])).toBe("critical");
  });

  it("13d. summarizeJobHealthCounts conta correttamente ogni stato, disabled incluso nel proprio bucket", () => {
    const evaluations = [
      makeEvaluation({ healthStatus: "healthy" }),
      makeEvaluation({ healthStatus: "healthy" }),
      makeEvaluation({ healthStatus: "warning" }),
      makeEvaluation({ healthStatus: "disabled", enabled: false }),
    ];
    expect(summarizeJobHealthCounts(evaluations)).toEqual({ healthy: 2, info: 0, warning: 1, critical: 0, disabled: 1, unknown: 0 });
  });
});

describe("evaluateJobHealth — poll-emails EVENT-DRIVEN (fix mirato: nessuna cadenza attesa, mai stale)", () => {
  // Usa la config REALE di produzione (JOB_HEALTH_CONFIG['poll-emails']), non una sintetica:
  // verifica che schedulingMode='event-driven' e staleAfterMinutes assente producano davvero
  // il comportamento richiesto, non solo un caso di test isolato.
  const pollEmailsConfig = JOB_HEALTH_CONFIG["poll-emails"]!;

  function pollEmailsRun(overrides: Partial<SystemJobRunRow> = {}): SystemJobRunRow {
    return makeRun({ job_key: "poll-emails", job_name: "Polling email", source: "api/cron/poll-emails", ...overrides });
  }

  it("1. mai eseguito -> unknown, MAI warning (nessuna finestra attesa da superare)", () => {
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs: [], now: NOW });
    expect(evaluation.healthStatus).toBe("unknown");
    expect(evaluation.healthStatus).not.toBe("warning");
  });

  it("2. ultimo run vecchio di 2 giorni, success -> healthy (mai stale, indipendentemente da quanto tempo e' passato)", () => {
    const runs = [pollEmailsRun({ status: "success", started_at: "2026-08-20T08:00:00.000Z", finished_at: "2026-08-20T08:00:10.000Z" })]; // 2 giorni prima di NOW
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs, now: NOW });
    expect(evaluation.stale).toBe(false);
    expect(evaluation.healthStatus).toBe("healthy");
  });

  it("2b. ultimo run vecchio di 30 giorni, success -> ancora healthy (nessun limite temporale, mai un valore fittizio applicato)", () => {
    const runs = [pollEmailsRun({ status: "success", started_at: "2026-07-23T08:00:00.000Z", finished_at: "2026-07-23T08:00:10.000Z" })];
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs, now: NOW });
    expect(evaluation.stale).toBe(false);
    expect(evaluation.healthStatus).toBe("healthy");
  });

  it("3. ultima esecuzione failed -> warning", () => {
    const runs = [pollEmailsRun({ status: "failed", started_at: "2026-08-22T09:00:00.000Z", error_message: "IMAP timeout" })];
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs, now: NOW });
    expect(evaluation.healthStatus).toBe("warning");
  });

  it("4. 3 fallimenti consecutivi reali -> critical", () => {
    const runs = [
      pollEmailsRun({ id: "r3", status: "failed", started_at: "2026-08-22T09:00:00.000Z" }),
      pollEmailsRun({ id: "r2", status: "failed", started_at: "2026-08-22T06:00:00.000Z" }),
      pollEmailsRun({ id: "r1", status: "failed", started_at: "2026-08-22T03:00:00.000Z" }),
    ];
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs, now: NOW });
    expect(evaluation.healthStatus).toBe("critical");
    expect(evaluation.consecutiveFailures).toBe(3);
  });

  it("5. running oltre il timeout previsto -> critical, stuck=true", () => {
    const runs = [pollEmailsRun({ status: "running", finished_at: null, started_at: "2026-08-22T09:45:00.000Z" })]; // 15 min prima, soglia poll-emails = 10
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs, now: NOW });
    expect(evaluation.healthStatus).toBe("critical");
    expect(evaluation.stuck).toBe(true);
  });

  it("6. skipped_no_pdf > 0 -> healthy con nota informativa, mai warning", () => {
    const runs = [
      pollEmailsRun({
        status: "success",
        started_at: "2026-08-22T09:00:00.000Z",
        warning_count: 1,
        metadata: { emails_processed: 1, skipped_no_pdf: 1, drafts_created: 0 },
      }),
    ];
    const evaluation = evaluateJobHealth({ config: pollEmailsConfig, runs, now: NOW });
    expect(evaluation.healthStatus).toBe("healthy");
    expect(evaluation.notes).toContain("1 email senza PDF");
  });
});
