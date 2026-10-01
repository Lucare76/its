/**
 * Unica regola condivisa (UI Biglietteria Medmar + preflight server) per
 * stabilire se un servizio appartiene a una pratica Medmar. Non allargare
 * oltre queste regole: un transfer_port_hotel SNAV non deve diventare Medmar.
 */
export type MedmarClassifiableService = {
  booking_service_kind?: string | null;
  vessel?: string | null;
  transport_code?: string | null;
};

export function isMedmarService(service: MedmarClassifiableService): boolean {
  const kind = service.booking_service_kind ?? null;
  // formula_snav prevale su vessel/transport_code: un "MEDMAR" lì è un dato
  // incoerente da segnalare, non una pratica da inviare a Medmar.
  if (kind === "formula_snav") return false;
  if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli") return true;
  if ((service.vessel ?? "").toLowerCase().includes("medmar")) return true;
  // Le pratiche PDF porto-hotel mostrano la compagnia da transport_code:
  // vessel puo' contenere solo il porto di arrivo, pur essendo MEDMAR.
  return kind === "transfer_port_hotel" && /medmar/i.test(service.transport_code ?? "");
}

/**
 * transfer_port_hotel con SNAV e MEDMAR nello stesso transport_code: il
 * servizio resta in coda (una delle tratte è Medmar), ma dalla sola riga non
 * si può stabilire con certezza quale tratta sia SNAV — l'ordine
 * "andata / ritorno" lo garantiscono solo gli import PDF/email, non Excel o
 * le modifiche manuali. Il preflight lo manda in revisione manuale.
 */
export function hasMixedSnavMedmarTransportCode(service: MedmarClassifiableService): boolean {
  if (service.booking_service_kind !== "transfer_port_hotel") return false;
  const code = service.transport_code ?? "";
  return /medmar/i.test(code) && /snav/i.test(code);
}

/** formula_snav con "MEDMAR" in vessel o transport_code: dato incoerente. */
export function hasContradictorySnavMedmarData(service: MedmarClassifiableService): boolean {
  if (service.booking_service_kind !== "formula_snav") return false;
  return /medmar/i.test(`${service.vessel ?? ""} ${service.transport_code ?? ""}`);
}
