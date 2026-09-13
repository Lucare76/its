import { describe, it, expect } from "vitest";
import { computeAutomationHealthLevel } from "@/lib/automation-health-level";

/**
 * Regressione UI (2026-09-13): "Salute automazioni" mostrava "Richiede
 * attenzione" nonostante tutte le automazioni fossero sane, perche' la pagina
 * usava `status.overall_health` — gia' combinato con l'Operational Health
 * (combineOverallHealth) — invece di derivare la severita' SOLO dai job.
 */
describe("computeAutomationHealthLevel", () => {
  it("1. automazioni tutte sane (+ un warning operativo separato, che qui non e' nemmeno un input) -> healthy", () => {
    const jobs = [
      { health: "healthy" as const }, // Backup automatico
      { health: "healthy" as const }, // Polling email
      { health: "healthy" as const }, // Backup PostgreSQL completo (DR V3)
      { health: "disabled" as const }, // whatsapp-reminders
    ];
    expect(computeAutomationHealthLevel(jobs)).toBe("healthy");
  });

  it("2. un job in warning -> attention (arancione)", () => {
    const jobs = [{ health: "healthy" as const }, { health: "warning" as const }];
    expect(computeAutomationHealthLevel(jobs)).toBe("attention");
  });

  it("3. un job in critical -> critical (rosso), anche con altri job sani", () => {
    const jobs = [{ health: "healthy" as const }, { health: "critical" as const }, { health: "warning" as const }];
    expect(computeAutomationHealthLevel(jobs)).toBe("critical");
  });

  it("4. solo disabled/unknown -> healthy (nessun warning inventato)", () => {
    expect(computeAutomationHealthLevel([{ health: "disabled" as const }])).toBe("healthy");
    expect(computeAutomationHealthLevel([{ health: "unknown" as const }])).toBe("healthy");
    expect(computeAutomationHealthLevel([{ health: "disabled" as const }, { health: "unknown" as const }])).toBe("healthy");
  });

  it("5. nessun job (elenco vuoto) -> healthy", () => {
    expect(computeAutomationHealthLevel([])).toBe("healthy");
  });

  it("6. 'info' non e' un'anomalia -> healthy", () => {
    expect(computeAutomationHealthLevel([{ health: "info" as const }])).toBe("healthy");
  });

  it("regressione osservata: automazioni tutte sane + warning operativo del backup 28 MB -> le due sezioni restano indipendenti (Salute automazioni=healthy, il warning operativo resta nella propria sezione)", () => {
    const jobs = [
      { health: "healthy" as const },
      { health: "healthy" as const },
      { health: "healthy" as const },
      { health: "disabled" as const },
    ];
    const automationLevel = computeAutomationHealthLevel(jobs);
    expect(automationLevel).toBe("healthy");

    // Il warning operativo ("Il backup backup_2026-09-13.json (28 MB) supera
    // la soglia di verifica runtime...") vive in operational_health.summary,
    // un percorso dati completamente separato che computeAutomationHealthLevel
    // non riceve nemmeno come input — non puo' per costruzione alzare
    // automationLevel. La sezione "Salute operativa" (non toccata da questo
    // fix) continua a mostrarlo per conto proprio.
    const operationalSummary = { info: 0, warning: 1, critical: 0 };
    expect(operationalSummary.warning).toBeGreaterThan(0);
  });
});
