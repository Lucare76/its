import { describe, expect, it } from "vitest";
import { JOB_HEALTH_CONFIG, JOB_HEALTH_KEYS, getJobHealthConfig } from "@/lib/server/job-health-config";

describe("job-health-config", () => {
  it("espone esattamente i 3 job monitorati dallo Sprint 1, nello stesso ordine atteso dalla route", () => {
    expect(JOB_HEALTH_KEYS).toEqual(["backup", "poll-emails", "whatsapp-reminders"]);
  });

  it("whatsapp-reminders e' configurato come non in uso (enabled=false)", () => {
    expect(JOB_HEALTH_CONFIG["whatsapp-reminders"]!.enabled).toBe(false);
  });

  it("backup e poll-emails sono abilitati", () => {
    expect(JOB_HEALTH_CONFIG.backup!.enabled).toBe(true);
    expect(JOB_HEALTH_CONFIG["poll-emails"]!.enabled).toBe(true);
  });

  it("ogni job definisce tutti i campi richiesti (job_key, nome, enabled, schedulingMode, cadenza, timeout, regole)", () => {
    for (const config of Object.values(JOB_HEALTH_CONFIG)) {
      expect(config.jobKey).toBeTruthy();
      expect(config.jobName).toBeTruthy();
      expect(typeof config.enabled).toBe("boolean");
      expect(["scheduled", "event-driven", "disabled"]).toContain(config.schedulingMode);
      expect(config.expectedCadence).toBeTruthy();
      expect(config.maxRunningMinutes).toBeGreaterThan(0);
      expect(config.criticalConsecutiveFailures).toBeGreaterThan(0);
      // staleAfterMinutes ha senso SOLO per job "scheduled": mai un valore fittizio per gli altri.
      if (config.schedulingMode === "scheduled") {
        expect(config.staleAfterMinutes).toBeGreaterThan(0);
      } else {
        expect(config.staleAfterMinutes).toBeUndefined();
      }
    }
  });

  it("getJobHealthConfig restituisce null per una chiave sconosciuta (mai un fallback inventato)", () => {
    expect(getJobHealthConfig("job-inesistente")).toBeNull();
  });

  it("getJobHealthConfig restituisce la config corretta per una chiave nota", () => {
    expect(getJobHealthConfig("backup")?.jobName).toBe("Backup automatico");
  });

  it("backup e' 'scheduled' (cadenza fissa attesa)", () => {
    expect(JOB_HEALTH_CONFIG.backup!.schedulingMode).toBe("scheduled");
    expect(JOB_HEALTH_CONFIG.backup!.staleAfterMinutes).toBeGreaterThan(0);
  });

  it("poll-emails e' 'event-driven': enabled=true, ma NESSUNA finestra temporale attesa (staleAfterMinutes assente, mai un valore fittizio come 0)", () => {
    const config = JOB_HEALTH_CONFIG["poll-emails"]!;
    expect(config.enabled).toBe(true);
    expect(config.schedulingMode).toBe("event-driven");
    expect(config.staleAfterMinutes).toBeUndefined();
    expect(config.firstExpectedAt).toBeUndefined();
    expect(config.maxRunningMinutes).toBeGreaterThan(0);
    expect(config.criticalConsecutiveFailures).toBeGreaterThan(0);
  });

  it("whatsapp-reminders e' 'disabled'", () => {
    expect(JOB_HEALTH_CONFIG["whatsapp-reminders"]!.schedulingMode).toBe("disabled");
  });
});
