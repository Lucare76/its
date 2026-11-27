/**
 * Avvisi scadenze flotta: una email per ogni scadenza, in due momenti.
 *  - "advance": N giorni prima (assicurazione e seconda rata 7, il resto 15)
 *  - "due": il giorno della scadenza, se non è stata rinnovata
 * Ogni avviso parte una sola volta (registro vehicle_compliance_alerts_sent).
 * Se il preavviso non è partito (cron saltato, scadenza inserita tardi) e la
 * scadenza è già arrivata, parte solo l'avviso del giorno.
 */
import { diffDays } from "@/lib/vehicle-compliance";

export type AlertDocType =
  | "insurance"
  | "insurance_installment"
  | "inspection"
  | "road_tax"
  | "extinguisher"
  | "tachograph_card"
  | "tachograph_calibration";

export type AlertStage = "advance" | "due";

export const ALERT_LEAD_DAYS: Record<AlertDocType, number> = {
  insurance: 7,
  insurance_installment: 7,
  inspection: 15,
  road_tax: 15,
  extinguisher: 15,
  tachograph_card: 15,
  tachograph_calibration: 15,
};

export const ALERT_DOC_LABEL: Record<AlertDocType, string> = {
  insurance: "Assicurazione",
  insurance_installment: "Seconda rata assicurazione",
  inspection: "Collaudo / revisione",
  road_tax: "Bollo",
  extinguisher: "Estintore",
  tachograph_card: "Carta tachigrafo autista",
  tachograph_calibration: "Taratura tachigrafo",
};

/** Scadenze più vecchie di così non generano avvisi (dati storici). */
export const MAX_OVERDUE_DAYS = 30;

export type AlertCandidate = {
  tenantId: string;
  vehicleId: string | null;
  subjectKey: string;
  docType: AlertDocType;
  dueDate: string;
  vehicleLabel: string;
  plate: string | null;
  detail?: string;
};

export type PlannedAlert = AlertCandidate & { stage: AlertStage; daysLeft: number };

export function alertKey(c: { tenantId: string; subjectKey: string; docType: string; dueDate: string }, stage: AlertStage) {
  return `${c.tenantId}|${c.subjectKey}|${c.docType}|${c.dueDate}|${stage}`;
}

export function planAlerts(candidates: AlertCandidate[], today: string, alreadySent: Set<string>): PlannedAlert[] {
  const planned: PlannedAlert[] = [];
  for (const candidate of candidates) {
    const daysLeft = diffDays(today, candidate.dueDate);
    if (daysLeft < -MAX_OVERDUE_DAYS) continue;
    const stage: AlertStage | null = daysLeft <= 0 ? "due" : daysLeft <= ALERT_LEAD_DAYS[candidate.docType] ? "advance" : null;
    if (!stage || alreadySent.has(alertKey(candidate, stage))) continue;
    planned.push({ ...candidate, stage, daysLeft });
  }
  return planned.sort((a, b) => a.daysLeft - b.daysLeft);
}

export function alertSubject(alert: PlannedAlert): string {
  const what = ALERT_DOC_LABEL[alert.docType];
  const vehicle = `${alert.vehicleLabel}${alert.plate ? ` (${alert.plate})` : ""}`;
  if (alert.daysLeft > 0) return `${what} in scadenza tra ${alert.daysLeft} ${alert.daysLeft === 1 ? "giorno" : "giorni"} — ${vehicle}`;
  if (alert.daysLeft === 0) return `${what} scade oggi — ${vehicle}`;
  return `${what} scaduta da ${-alert.daysLeft} ${alert.daysLeft === -1 ? "giorno" : "giorni"} — ${vehicle}`;
}
