import type { MedmarIssueConfig } from "./issue-types";

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

function parsePositiveInt(value: string | undefined): number | null {
  const cleaned = clean(value);
  if (!/^\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function getMedmarIssueConfig(): MedmarIssueConfig {
  return {
    enabled: clean(process.env.MEDMAR_ISSUING_ENABLED) === "true",
    causaleId: parsePositiveInt(process.env.MEDMAR_CAUSALE_ID) ?? 1,
    modalitaId: parsePositiveInt(process.env.MEDMAR_MODALITA_ID) ?? 5,
    vettoreAndataId: parsePositiveInt(process.env.MEDMAR_VETTORE_ANDATA_ID) ?? 1,
    vettoreRitornoId: parsePositiveInt(process.env.MEDMAR_VETTORE_RITORNO_ID) ?? 1,
  };
}

export function validateMedmarIssueConfig(config: MedmarIssueConfig): string | null {
  if (!config.enabled) return "feature_disabled";
  if (config.modalitaId !== 5) return "unsupported_payment_mode";
  return null;
}
