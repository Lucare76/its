/**
 * Formattatori di risposta business-oriented per Mario Assistant (Sprint 6)
 * — pure, prendono l'output gia' validato dei tool MCP Sprint 5 e producono
 * prosa italiana + eventuali action link. Mai un dump JSON nella risposta
 * testuale (il JSON strutturato resta disponibile a parte in `data`).
 */
import { timeStringToMinutes, type TimeWindow } from "./date-time";

export type MarioAction = { label: string; href: string };
export type MarioAnswer = { answer: string; actions: MarioAction[] };

type SignalAction = { label: string; href: string } | null | undefined;
type SignalLike = {
  key: string;
  area: string;
  title: string;
  message: string;
  entity_id?: string | null;
  action?: SignalAction;
};

function collectActions(signals: readonly SignalLike[]): MarioAction[] {
  const actions: MarioAction[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (!s.action) continue;
    const key = `${s.action.label}|${s.action.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ label: s.action.label, href: s.action.href });
  }
  return actions;
}

// ─── its.get_operational_brief ─────────────────────────────────────────────

export type OperationalBriefOutput = {
  date: string;
  summary: { total_services: number; upcoming_services: number; unassigned_services: number; active_services: number };
  critical_items: SignalLike[];
  warnings: SignalLike[];
  health: { available: boolean; overall: "healthy" | "attention" | "critical" | null };
};

export function formatOperationalBriefAnswer(output: OperationalBriefOutput): MarioAnswer {
  const { summary, critical_items, warnings, health } = output;
  const parts: string[] = [];

  parts.push(
    `Il ${output.date} ci sono ${summary.total_services} servizi (${summary.active_services} in corso, ${summary.upcoming_services} ancora da fare).`
  );

  const problemCount = critical_items.length + warnings.length;
  if (problemCount === 0) {
    parts.push("Nessun problema operativo rilevato.");
  } else {
    const bits: string[] = [];
    if (critical_items.length > 0) bits.push(`${critical_items.length} critici`);
    if (warnings.length > 0) bits.push(`${warnings.length} warning`);
    parts.push(`${problemCount} richiedono attenzione: ${bits.join(", ")}.`);
  }

  if (summary.unassigned_services > 0) {
    parts.push(`${summary.unassigned_services} servizi sono ancora senza autista.`);
  }

  if (!health.available) {
    parts.push("Al momento non riesco a leggere lo stato di salute generale.");
  } else if (health.overall === "critical") {
    parts.push("Attenzione: lo stato di salute generale di ITS è critico.");
  } else if (health.overall === "attention") {
    parts.push("Lo stato di salute generale di ITS richiede attenzione.");
  }

  return { answer: parts.join(" "), actions: collectActions([...critical_items, ...warnings]) };
}

// ─── its.get_health_status ─────────────────────────────────────────────────

export type HealthStatusOutput = {
  available: boolean;
  overall: "healthy" | "attention" | "critical" | null;
  job_health: { jobs: Array<{ job_key: string; job_name: string; health: string; enabled: boolean }> } | null;
  operational_health: { summary: { info: number; warning: number; critical: number } } | null;
};

const OVERALL_LABEL: Record<string, string> = {
  healthy: "ITS è sano",
  attention: "ITS ha qualche anomalia da tenere sotto controllo",
  critical: "ITS ha un problema critico",
};

export function formatHealthStatusAnswer(output: HealthStatusOutput): MarioAnswer {
  if (!output.available || !output.overall) {
    return { answer: "Al momento non riesco a leggere lo stato di salute di ITS.", actions: [] };
  }

  const parts: string[] = [`${OVERALL_LABEL[output.overall] ?? "Stato di ITS sconosciuto"}.`];

  const jobs = output.job_health?.jobs.filter((j) => j.enabled) ?? [];
  const unhealthyJobs = jobs.filter((j) => j.health !== "healthy");
  if (jobs.length > 0) {
    if (unhealthyJobs.length === 0) {
      parts.push(`Tutti i processi automatici (${jobs.map((j) => j.job_name).join(", ")}) sono OK.`);
    } else {
      parts.push(`Da controllare: ${unhealthyJobs.map((j) => `${j.job_name} (${j.health})`).join(", ")}.`);
    }
  }

  const opSummary = output.operational_health?.summary;
  if (opSummary) {
    if (opSummary.critical === 0 && opSummary.warning === 0) {
      parts.push("Nessuna anomalia operativa critica.");
    } else {
      parts.push(`Operativamente: ${opSummary.critical} critici, ${opSummary.warning} warning.`);
    }
  }

  return { answer: parts.join(" "), actions: [] };
}

// ─── its.get_operational_alerts ────────────────────────────────────────────

export type OperationalAlertsOutput = { severity_filter: string; alerts: SignalLike[] };

export function formatAlertsAnswer(output: OperationalAlertsOutput): MarioAnswer {
  if (output.alerts.length === 0) {
    return { answer: "Nessun alert al momento.", actions: [] };
  }
  const critical = output.alerts.filter((a) => (a as SignalLike & { severity?: string }).severity === "critical");
  const warning = output.alerts.filter((a) => (a as SignalLike & { severity?: string }).severity === "warning");

  const lines = output.alerts.map((a) => `• ${a.title}${a.entity_id ? ` (${a.entity_id})` : ""}: ${a.message}`);
  const summary = `${output.alerts.length} alert (${critical.length} critici, ${warning.length} warning):`;

  return { answer: [summary, ...lines].join("\n"), actions: collectActions(output.alerts) };
}

// ─── its.get_unassigned_services ───────────────────────────────────────────

export type UnassignedServicesOutput = {
  date: string;
  count: number;
  services: Array<{ id: string; time: string; direction: string | null; practice_number: string | null; minutes_until: number | null }>;
};

export function formatUnassignedAnswer(output: UnassignedServicesOutput): MarioAnswer {
  if (output.count === 0) {
    return { answer: `Nessun servizio senza autista per il ${output.date}.`, actions: [] };
  }

  const lines = output.services.map((s) => {
    const label = s.practice_number ?? `servizio ${s.id.slice(0, 8)}`;
    const direction = s.direction === "arrival" ? "Arrivo" : s.direction === "departure" ? "Partenza" : "Servizio";
    return `• ${direction} ${label} delle ${s.time.slice(0, 5)}`;
  });

  // Stesso pattern href gia' introdotto in Sprint 4 (serviceEditAction in
  // operations-health.ts) — riusato qui, non una nuova action.
  const actions: MarioAction[] = output.services.map((s) => ({ label: "Apri servizio", href: `/services/${s.id}/edit` }));

  return {
    answer: [`${output.count} servizi senza autista per il ${output.date}:`, ...lines].join("\n"),
    actions,
  };
}

// ─── its.get_driver_availability ───────────────────────────────────────────

export type DriverAvailabilityOutput = {
  date: string;
  drivers: Array<{
    full_name: string;
    active: boolean;
    access_suspended: boolean;
    assigned_services: Array<{ time: string | null }>;
  }>;
};

/** true se un driver ha un servizio assegnato che si sovrappone alla finestra richiesta — nessuno scoring, solo un fatto deterministico gia' presente nei dati. */
function isBusyInWindow(driver: DriverAvailabilityOutput["drivers"][number], window: TimeWindow): boolean {
  return driver.assigned_services.some((s) => {
    const minutes = timeStringToMinutes(s.time);
    return minutes !== null && minutes >= window.fromMinutes && minutes <= window.toMinutes;
  });
}

export function formatDriverAvailabilityAnswer(output: DriverAvailabilityOutput, timeWindow?: TimeWindow): MarioAnswer {
  const activeDrivers = output.drivers.filter((d) => d.active && !d.access_suspended);
  if (activeDrivers.length === 0) {
    return { answer: `Nessun autista attivo disponibile per il ${output.date}.`, actions: [] };
  }

  if (!timeWindow) {
    const lines = activeDrivers.map((d) => `• ${d.full_name}: ${d.assigned_services.length} servizi assegnati`);
    return { answer: [`Autisti attivi per il ${output.date}:`, ...lines].join("\n"), actions: [] };
  }

  const free = activeDrivers.filter((d) => !isBusyInWindow(d, timeWindow));
  const busy = activeDrivers.filter((d) => isBusyInWindow(d, timeWindow));

  const lines: string[] = [];
  if (free.length > 0) lines.push(`Liberi ${timeWindow.label}: ${free.map((d) => d.full_name).join(", ")}.`);
  if (busy.length > 0) lines.push(`Occupati ${timeWindow.label} (in base ai servizi già assegnati): ${busy.map((d) => d.full_name).join(", ")}.`);

  return { answer: lines.join(" "), actions: [] };
}
