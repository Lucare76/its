// Etichette leggibili per i campi di service_change_logs.changed_fields,
// condivise tra la normalizzazione server-side della Timeline
// (lib/server/service-timeline.ts) e la UI che le mostra
// (components/service-timeline.tsx). Estratto invariato dalla mappa già in
// uso in app/(app)/services/[id]/edit/page.tsx (fieldLabel) — stesse
// chiavi/valori, nessun comportamento esistente cambiato.
const SERVICE_FIELD_LABELS: Record<string, string> = {
  customer_name: "cliente",
  phone: "telefono",
  pax: "pax",
  time: "orario",
  notes: "note",
  hotel_id: "hotel",
  agency_id: "agenzia",
  billing_party_name: "intestatario",
  meeting_point: "meeting point",
  arrival_date: "data arrivo",
  arrival_time: "ora arrivo",
  departure_date: "data partenza",
  departure_time: "ora partenza",
  orario_barca: "orario barca",
  pickup_time: "pickup",
  transport_code: "rif. volo/treno",
  status: "stato",
};

export function serviceFieldLabel(field: string): string {
  return SERVICE_FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}
