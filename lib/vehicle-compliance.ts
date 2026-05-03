export type ComplianceStatus = "expired" | "critical" | "warning" | "missing" | "ok";

export const COMPLIANCE_STATUS_RANK: Record<ComplianceStatus, number> = {
  expired: 0,
  critical: 1,
  warning: 2,
  missing: 3,
  ok: 4,
};

export const INSURANCE_GRACE_DAYS = 15;
export const WARN_DAYS = 60;
export const INSURANCE_WARN_WINDOW_DAYS = 61;

/** Giorni interi tra due date ISO (positivo = futuro, negativo = passato). */
export function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

/** Aggiunge n giorni a una data ISO e restituisce la nuova data ISO. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Converte i giorni rimanenti a scadenza in un livello di stato.
 * Soglie: expired < 0 | critical ≤ 7 | warning ≤ 30 | ok altrimenti | missing se null.
 */
export function expiryStatus(daysLeft: number | null): ComplianceStatus {
  if (daysLeft === null) return "missing";
  if (daysLeft < 0) return "expired";
  if (daysLeft <= 7) return "critical";
  if (daysLeft <= 30) return "warning";
  return "ok";
}

/** Stato peggiore tra un array di stati (expired > critical > warning > missing > ok). */
export function worstStatus(statuses: ComplianceStatus[]): ComplianceStatus {
  return statuses.reduce<ComplianceStatus>(
    (worst, s) => (COMPLIANCE_STATUS_RANK[s] < COMPLIANCE_STATUS_RANK[worst] ? s : worst),
    "ok"
  );
}

/** Etichetta leggibile per una scadenza (usata nelle email di avviso). */
export function buildStatusLabel(daysLeft: number): string {
  if (daysLeft < 0) return `SCADUTO da ${Math.abs(daysLeft)} giorni`;
  if (daysLeft === 0) return "SCADE OGGI";
  return `Scade tra ${daysLeft} giorn${daysLeft === 1 ? "o" : "i"}`;
}

/**
 * Stato assicurazione con proroga di 15 giorni (art. 170-bis CdA).
 * expired solo dopo expiry + INSURANCE_GRACE_DAYS; critical se in proroga o ≤7 gg.
 */
export function insuranceExpiryStatus(expiryDate: string, today: string): ComplianceStatus {
  const daysToNominal = diffDays(today, expiryDate);
  const graceDeadline = addDays(expiryDate, INSURANCE_GRACE_DAYS);
  const daysToGrace = diffDays(today, graceDeadline);
  if (daysToGrace < 0) return "expired";
  if (daysToNominal <= 7) return "critical";
  if (daysToNominal <= 30) return "warning";
  return "ok";
}

/**
 * Status collaudo con regola "fine mese": la revisione si può fare entro la
 * fine del mese di scadenza. L'expired scatta solo dopo l'ultimo giorno del mese.
 */
export function inspectionExpiryStatus(expiryDate: string, today: string): ComplianceStatus {
  const endOfExpiryMonth = getInspectionEffectiveExpiry(expiryDate);

  const daysToDeadline = diffDays(today, endOfExpiryMonth);
  const daysToExpiry = diffDays(today, expiryDate);

  if (daysToDeadline < 0) return "expired";                       // fine mese superata
  if (daysToExpiry <= 0) return "critical";                       // scaduto ma siamo ancora nel mese
  if (expiryDate.slice(0, 7) === today.slice(0, 7)) return "critical"; // scade questo mese
  if (daysToExpiry <= 30) return "warning";
  return "ok";
}

/** Scadenza effettiva considerando l'eventuale proroga per tipo documento. */
export function getInspectionEffectiveExpiry(expiryDate: string): string {
  const [ey, em] = expiryDate.slice(0, 7).split("-").map(Number);
  const lastDay = new Date(ey!, em!, 0).getDate();
  return `${ey}-${String(em).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** Scadenza effettiva considerando l'eventuale proroga per tipo documento. */
export function getEffectiveExpiry(docType: string, expiry: string): string {
  if (docType === "Assicurazione") return addDays(expiry, INSURANCE_GRACE_DAYS);
  if (docType === "Collaudo") return getInspectionEffectiveExpiry(expiry);
  return expiry;
}

/** Finestra di avviso in giorni per tipo documento. */
export function getWarnWindowDays(docType: string): number {
  return docType === "Assicurazione" ? INSURANCE_WARN_WINDOW_DAYS : WARN_DAYS;
}
