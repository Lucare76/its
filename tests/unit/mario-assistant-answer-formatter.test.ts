import { describe, it, expect } from "vitest";
import {
  formatOperationalBriefAnswer,
  formatHealthStatusAnswer,
  formatAlertsAnswer,
  formatUnassignedAnswer,
  formatDriverAvailabilityAnswer,
  type OperationalBriefOutput,
  type HealthStatusOutput,
  type OperationalAlertsOutput,
  type UnassignedServicesOutput,
  type DriverAvailabilityOutput,
} from "@/lib/server/mario-assistant/answer-formatter";

describe("formatOperationalBriefAnswer", () => {
  it("giornata sana: nessun problema menzionato, nessuna action", () => {
    const output: OperationalBriefOutput = {
      date: "2026-08-23",
      summary: { total_services: 42, upcoming_services: 10, unassigned_services: 0, active_services: 5 },
      critical_items: [],
      warnings: [],
      health: { available: true, overall: "healthy" },
    };
    const { answer, actions } = formatOperationalBriefAnswer(output);
    expect(answer).toContain("42 servizi");
    expect(answer).toContain("Nessun problema operativo rilevato");
    expect(actions).toEqual([]);
  });

  it("con critici e warning: conteggio corretto e action raccolte", () => {
    const output: OperationalBriefOutput = {
      date: "2026-08-23",
      summary: { total_services: 42, upcoming_services: 10, unassigned_services: 1, active_services: 5 },
      critical_items: [
        {
          key: "operations:unassigned:svc-1",
          area: "operations",
          title: "Servizio imminente senza autista assegnato",
          message: "Arrivo ITS-1 delle 18:30 parte fra 20 minuti senza autista assegnato.",
          action: { label: "Apri servizio", href: "/services/svc-1/edit" },
        },
      ],
      warnings: [
        {
          key: "medmar:delivery_pending:d1",
          area: "medmar",
          title: "Consegna biglietto in attesa",
          message: "Consegna in attesa.",
          action: { label: "Apri Medmar", href: "/biglietti-medmar" },
        },
        {
          key: "medmar:delivery_pending:d2",
          area: "medmar",
          title: "Consegna biglietto in attesa",
          message: "Consegna in attesa.",
          action: { label: "Apri Medmar", href: "/biglietti-medmar" },
        },
      ],
      health: { available: true, overall: "critical" },
    };
    const { answer, actions } = formatOperationalBriefAnswer(output);
    expect(answer).toContain("1 critici");
    expect(answer).toContain("2 warning");
    expect(answer).toContain("critico");
    // Le due action Medmar sono identiche -> deduplicate.
    expect(actions).toEqual([
      { label: "Apri servizio", href: "/services/svc-1/edit" },
      { label: "Apri Medmar", href: "/biglietti-medmar" },
    ]);
  });
});

describe("formatHealthStatusAnswer", () => {
  it("healthy: menziona tutti i job OK, nessuna anomalia operativa", () => {
    const output: HealthStatusOutput = {
      available: true,
      overall: "healthy",
      job_health: { jobs: [{ job_key: "backup", job_name: "Backup automatico", health: "healthy", enabled: true }] },
      operational_health: { summary: { info: 0, warning: 0, critical: 0 } },
    };
    const { answer } = formatHealthStatusAnswer(output);
    expect(answer).toContain("sano");
    expect(answer).toContain("Backup automatico");
    expect(answer).toContain("Nessuna anomalia operativa critica");
  });

  it("failure isolation: available=false -> messaggio leggibile, mai un crash", () => {
    const output: HealthStatusOutput = { available: false, overall: null, job_health: null, operational_health: null };
    const { answer } = formatHealthStatusAnswer(output);
    expect(answer).toContain("non riesco a leggere");
  });
});

describe("formatAlertsAnswer", () => {
  it("nessun alert -> messaggio rassicurante", () => {
    const output: OperationalAlertsOutput = { severity_filter: "all", alerts: [] };
    expect(formatAlertsAnswer(output).answer).toBe("Nessun alert al momento.");
  });

  it("con alert: action link mantenuti e deduplicati", () => {
    const output: OperationalAlertsOutput = {
      severity_filter: "all",
      alerts: [
        {
          key: "k1",
          area: "operations",
          severity: "critical",
          title: "T1",
          message: "M1",
          entity_id: "ITS-1",
          action: { label: "Apri servizio", href: "/services/svc-1/edit" },
        } as never,
      ],
    };
    const { answer, actions } = formatAlertsAnswer(output);
    expect(answer).toContain("ITS-1");
    expect(actions).toEqual([{ label: "Apri servizio", href: "/services/svc-1/edit" }]);
  });
});

describe("formatUnassignedAnswer", () => {
  it("zero servizi -> messaggio rassicurante, nessuna action", () => {
    const output: UnassignedServicesOutput = { date: "2026-08-23", count: 0, services: [] };
    const { answer, actions } = formatUnassignedAnswer(output);
    expect(answer).toContain("Nessun servizio senza autista");
    expect(actions).toEqual([]);
  });

  it("con servizi: costruisce action /services/{id}/edit riusando il pattern Sprint 4", () => {
    const output: UnassignedServicesOutput = {
      date: "2026-08-23",
      count: 1,
      services: [{ id: "svc-1", time: "18:30", direction: "arrival", practice_number: "ITS-2026-1", minutes_until: 20 }],
    };
    const { actions } = formatUnassignedAnswer(output);
    expect(actions).toEqual([{ label: "Apri servizio", href: "/services/svc-1/edit" }]);
  });
});

describe("formatDriverAvailabilityAnswer", () => {
  it("senza finestra oraria: elenca autisti attivi con conteggio servizi", () => {
    const output: DriverAvailabilityOutput = {
      date: "2026-08-23",
      drivers: [{ full_name: "Mario Rossi", active: true, access_suspended: false, assigned_services: [{ time: "10:00" }] }],
    };
    const { answer } = formatDriverAvailabilityAnswer(output);
    expect(answer).toContain("Mario Rossi");
  });

  it("con finestra oraria: distingue liberi da occupati in base agli slot gia' assegnati", () => {
    const output: DriverAvailabilityOutput = {
      date: "2026-08-23",
      drivers: [
        { full_name: "Libero Bianchi", active: true, access_suspended: false, assigned_services: [{ time: "08:00" }] },
        { full_name: "Occupato Verdi", active: true, access_suspended: false, assigned_services: [{ time: "15:30" }] },
      ],
    };
    const { answer } = formatDriverAvailabilityAnswer(output, { fromMinutes: 15 * 60, toMinutes: 20 * 60, label: "dalle 15:00 alle 20:00" });
    expect(answer).toContain("Liberi");
    expect(answer).toContain("Libero Bianchi");
    expect(answer).toContain("Occupati");
    expect(answer).toContain("Occupato Verdi");
  });

  it("autista non attivo o access_suspended escluso dall'elenco (motivo gia' noto, non un giudizio nuovo)", () => {
    const output: DriverAvailabilityOutput = {
      date: "2026-08-23",
      drivers: [{ full_name: "Sospeso Neri", active: true, access_suspended: true, assigned_services: [] }],
    };
    const { answer } = formatDriverAvailabilityAnswer(output);
    expect(answer).not.toContain("Sospeso Neri");
  });
});
