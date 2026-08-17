/**
 * Fase 2B.6 — risoluzione destinatari email del flusso Medmar One Click.
 *
 * Due destinatari, mai confusi:
 * - "medmar_recipient": email TECNICA Medmar, fissa e server-side (mai da
 *   customer_email/agency email/browser). Va SOLO nel payload verso Medmar.
 * - "final_recipient": destinatario commerciale del documento pulito ITS
 *   (agenzia se la pratica ne ha una — l'agenzia vince SEMPRE, mai fallback
 *   silenzioso al cliente — altrimenti il cliente). Non entra mai nel
 *   payload Medmar.
 *
 * Nessun fallback implicito: ogni ramo mancante fallisce con un codice
 * distinto, fail-closed.
 */
import { getMedmarDeliveryConfig } from "./delivery-config";

export type MedmarTechnicalRecipient = { type: "technical"; email: string };
export type MedmarFinalRecipient =
  | { type: "agency"; name: string; email: string }
  | { type: "customer"; name: string; email: string };

export type AgencyRecipientCandidate = { name: string; email: string | null } | null;

export type MedmarTechnicalRecipientResult =
  | { ok: true; recipient: MedmarTechnicalRecipient }
  | { ok: false; code: "medmar_delivery_email_not_configured"; error: string };

export type MedmarFinalRecipientResult =
  | { ok: true; recipient: MedmarFinalRecipient }
  | { ok: false; code: "agency_recipient_email_missing" | "customer_recipient_email_missing"; error: string };

export type MedmarDeliveryResolution =
  | { ok: true; medmar_recipient: MedmarTechnicalRecipient; final_recipient: MedmarFinalRecipient }
  | {
      ok: false;
      code: "medmar_delivery_email_not_configured" | "agency_recipient_email_missing" | "customer_recipient_email_missing";
      error: string;
    };

export function resolveMedmarTechnicalRecipient(): MedmarTechnicalRecipientResult {
  const { technicalEmail } = getMedmarDeliveryConfig();
  if (!technicalEmail) {
    return {
      ok: false,
      code: "medmar_delivery_email_not_configured",
      error: "Email tecnica Medmar non configurata (MEDMAR_DELIVERY_EMAIL).",
    };
  }
  return { ok: true, recipient: { type: "technical", email: technicalEmail } };
}

export function resolveFinalTicketRecipient(input: {
  agency: AgencyRecipientCandidate;
  customerName: string | null;
  customerEmail: string | null;
}): MedmarFinalRecipientResult {
  if (input.agency) {
    if (!input.agency.email) {
      return {
        ok: false,
        code: "agency_recipient_email_missing",
        error: `Email agenzia mancante per "${input.agency.name}": nessun fallback automatico al cliente.`,
      };
    }
    return { ok: true, recipient: { type: "agency", name: input.agency.name, email: input.agency.email } };
  }
  const customerEmail = (input.customerEmail ?? "").trim();
  if (!customerEmail) {
    return {
      ok: false,
      code: "customer_recipient_email_missing",
      error: "Email cliente mancante per il destinatario finale.",
    };
  }
  return { ok: true, recipient: { type: "customer", name: input.customerName ?? "Cliente", email: customerEmail } };
}

export function resolveMedmarDelivery(input: {
  agency: AgencyRecipientCandidate;
  customerName: string | null;
  customerEmail: string | null;
}): MedmarDeliveryResolution {
  const technical = resolveMedmarTechnicalRecipient();
  if (!technical.ok) return technical;
  const final = resolveFinalTicketRecipient(input);
  if (!final.ok) return final;
  return { ok: true, medmar_recipient: technical.recipient, final_recipient: final.recipient };
}
