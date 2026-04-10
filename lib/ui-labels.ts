import type { ServiceStatus, ServiceType } from "@/lib/types";

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  transfer: "Transfer",
  bus_tour: "Escursione bus"
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  needs_review: "Da revisionare",
  new: "Nuovo",
  assigned: "Assegnato",
  partito: "Partito",
  arrivato: "Arrivato",
  completato: "Completato",
  problema: "Problema",
  cancelled: "Annullato"
};
