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
  if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli") return true;
  if ((service.vessel ?? "").toLowerCase().includes("medmar")) return true;
  // Le pratiche PDF porto-hotel mostrano la compagnia da transport_code:
  // vessel puo' contenere solo il porto di arrivo, pur essendo MEDMAR.
  return kind === "transfer_port_hotel" && /medmar/i.test(service.transport_code ?? "");
}
