/**
 * Regole di prelevamento per partenze — derivate dal PDF "Partenze Ischia".
 * Uso: dato (agencyName, transportType, timeKey, zona) → orario prelevamento + barca.
 *
 * transport_type:
 *   'treno_traghetto' | 'treno_aliscafo' | 'volo_traghetto' | 'volo_aliscafo'
 *   | 'snav' | 'medmar_napoli' | 'medmar_pozzuoli'
 *
 * t_from / t_to: orari del treno o volo (formato HH:MM).
 *   Per SNAV/MEDMAR diretti: t_from = orario barca, t_to = null.
 *
 * not_sosandra: la regola NON vale per l'agenzia SOSANDRA.
 * forio_only:  questa riga vale solo per la zona FORIO (le altre agenzie la hanno, SOSANDRA no).
 */

export type PickupRule = {
  transport_type: string;
  t_from: string;
  t_to: string | null;
  zona: string;
  pickup: string;
  boat_co: string;
  boat_t: string;
  porto_p: string;   // porto di partenza
  porto_a: string;   // porto di arrivo
  exc?: string;      // eccezioni stagionali
  notes?: string;    // note punti carico speciali
  not_sosandra?: true;
};

// ---------------------------------------------------------------------------
// Helper: note punti carico per zone FORIO e LACCO
// ---------------------------------------------------------------------------
const FORIO_NOTES = "Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno";
const LACCO_NOTES = "Hotel Augusto: carico Bar Campo";

// ---------------------------------------------------------------------------
// TRENO + TRAGHETTO  (MEDMAR — Pozzuoli)
// SOSANDRA: zone ischia/lacco/casamicciola/barano
// ALESTE+: aggiunge forio
// ---------------------------------------------------------------------------
const TRENO_TRAGHETTO: PickupRule[] = [
  // slot 1 — treno 09:00→10:55
  { transport_type: "treno_traghetto", t_from: "09:00", t_to: "10:55", zona: "ischia",       pickup: "05:15", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "09:00", t_to: "10:55", zona: "lacco",        pickup: "05:15", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_traghetto", t_from: "09:00", t_to: "10:55", zona: "casamicciola", pickup: "05:30", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "09:00", t_to: "10:55", zona: "barano",       pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "09:00", t_to: "10:55", zona: "forio",        pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 2 — treno 11:00→13:15
  { transport_type: "treno_traghetto", t_from: "11:00", t_to: "13:15", zona: "ischia",       pickup: "07:20", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_traghetto", t_from: "11:00", t_to: "13:15", zona: "lacco",        pickup: "07:10", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "treno_traghetto", t_from: "11:00", t_to: "13:15", zona: "casamicciola", pickup: "07:15", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_traghetto", t_from: "11:00", t_to: "13:15", zona: "barano",       pickup: "07:10", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_traghetto", t_from: "11:00", t_to: "13:15", zona: "forio",        pickup: "07:00", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 3 — treno 13:20→16:30
  { transport_type: "treno_traghetto", t_from: "13:20", t_to: "16:30", zona: "ischia",       pickup: "08:40", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "13:20", t_to: "16:30", zona: "lacco",        pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_traghetto", t_from: "13:20", t_to: "16:30", zona: "casamicciola", pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "13:20", t_to: "16:30", zona: "barano",       pickup: "08:15", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "13:20", t_to: "16:30", zona: "forio",        pickup: "08:30", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 4 — treno 16:35→18:40
  { transport_type: "treno_traghetto", t_from: "16:35", t_to: "18:40", zona: "ischia",       pickup: "12:30", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "16:35", t_to: "18:40", zona: "lacco",        pickup: "12:30", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_traghetto", t_from: "16:35", t_to: "18:40", zona: "casamicciola", pickup: "12:40", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "16:35", t_to: "18:40", zona: "barano",       pickup: "12:15", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_traghetto", t_from: "16:35", t_to: "18:40", zona: "forio",        pickup: "12:15", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 5 — treno 18:45→23:30
  { transport_type: "treno_traghetto", t_from: "18:45", t_to: "23:30", zona: "ischia",       pickup: "14:00", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_traghetto", t_from: "18:45", t_to: "23:30", zona: "lacco",        pickup: "14:00", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "treno_traghetto", t_from: "18:45", t_to: "23:30", zona: "casamicciola", pickup: "14:00", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_traghetto", t_from: "18:45", t_to: "23:30", zona: "barano",       pickup: "13:45", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_traghetto", t_from: "18:45", t_to: "23:30", zona: "forio",        pickup: "13:45", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
];

// ---------------------------------------------------------------------------
// TRENO + ALISCAFO  (ALILAURO / SNAV — Napoli)
// ---------------------------------------------------------------------------
const TRENO_ALISCAFO: PickupRule[] = [
  // slot 1 — 08:30→09:25  ALILAURO 06:30 Napoli→Ischia
  { transport_type: "treno_aliscafo", t_from: "08:30", t_to: "09:25", zona: "ischia",       pickup: "05:45", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "08:30", t_to: "09:25", zona: "lacco",        pickup: "05:30", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "08:30", t_to: "09:25", zona: "casamicciola", pickup: "05:30", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "08:30", t_to: "09:25", zona: "barano",       pickup: "05:30", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  // slot 2 — 09:30→10:40  SNAV 07:10 Napoli→Casamicciola
  { transport_type: "treno_aliscafo", t_from: "09:30", t_to: "10:40", zona: "ischia",       pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "09:30", t_to: "10:40", zona: "lacco",        pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "09:30", t_to: "10:40", zona: "casamicciola", pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "09:30", t_to: "10:40", zona: "barano",       pickup: "06:15", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "09:30", t_to: "10:40", zona: "forio",        pickup: "06:15", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 3 — 11:45→13:40  SNAV 09:45 Napoli→Casamicciola
  { transport_type: "treno_aliscafo", t_from: "11:45", t_to: "13:40", zona: "ischia",       pickup: "08:40", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "11:45", t_to: "13:40", zona: "lacco",        pickup: "08:45", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "11:45", t_to: "13:40", zona: "casamicciola", pickup: "08:45", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "11:45", t_to: "13:40", zona: "barano",       pickup: "08:15", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "11:45", t_to: "13:40", zona: "forio",        pickup: "08:30", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 4 — 13:45→16:10  ALILAURO 11:45 Napoli→Ischia
  { transport_type: "treno_aliscafo", t_from: "13:45", t_to: "16:10", zona: "ischia",       pickup: "11:00", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "13:45", t_to: "16:10", zona: "lacco",        pickup: "10:45", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "13:45", t_to: "16:10", zona: "casamicciola", pickup: "10:45", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "13:45", t_to: "16:10", zona: "barano",       pickup: "10:30", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "13:45", t_to: "16:10", zona: "forio",        pickup: "10:30", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 5 — 16:15→18:10  SNAV 14:00 Napoli→Casamicciola
  { transport_type: "treno_aliscafo", t_from: "16:15", t_to: "18:10", zona: "ischia",       pickup: "12:30", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "16:15", t_to: "18:10", zona: "lacco",        pickup: "12:45", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "16:15", t_to: "18:10", zona: "casamicciola", pickup: "12:45", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "16:15", t_to: "18:10", zona: "barano",       pickup: "12:30", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "16:15", t_to: "18:10", zona: "forio",        pickup: "12:15", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 6 — 18:15→19:55  ALILAURO 16:15 Napoli→Ischia
  { transport_type: "treno_aliscafo", t_from: "18:15", t_to: "19:55", zona: "ischia",       pickup: "15:30", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "18:15", t_to: "19:55", zona: "lacco",        pickup: "15:15", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "18:15", t_to: "19:55", zona: "casamicciola", pickup: "15:15", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "18:15", t_to: "19:55", zona: "barano",       pickup: "15:00", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "treno_aliscafo", t_from: "18:15", t_to: "19:55", zona: "forio",        pickup: "15:00", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 7 — 20:00→23:55  SNAV 17:40 Napoli→Casamicciola
  { transport_type: "treno_aliscafo", t_from: "20:00", t_to: "23:55", zona: "ischia",       pickup: "16:40", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "20:00", t_to: "23:55", zona: "lacco",        pickup: "16:40", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "treno_aliscafo", t_from: "20:00", t_to: "23:55", zona: "casamicciola", pickup: "16:40", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "20:00", t_to: "23:55", zona: "barano",       pickup: "16:15", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "treno_aliscafo", t_from: "20:00", t_to: "23:55", zona: "forio",        pickup: "16:15", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
];

// ---------------------------------------------------------------------------
// VOLO + TRAGHETTO  (MEDMAR — Pozzuoli) — solo ALESTE e simili, non SOSANDRA
// ---------------------------------------------------------------------------
const VOLO_TRAGHETTO: PickupRule[] = [
  // slot 1 — volo 10:00→12:30
  { transport_type: "volo_traghetto", t_from: "10:00", t_to: "12:30", zona: "ischia",       pickup: "05:15", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "10:00", t_to: "12:30", zona: "lacco",        pickup: "05:15", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "10:00", t_to: "12:30", zona: "casamicciola", pickup: "05:15", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "10:00", t_to: "12:30", zona: "barano",       pickup: "05:30", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "10:00", t_to: "12:30", zona: "forio",        pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 2 — volo 12:40→14:30
  { transport_type: "volo_traghetto", t_from: "12:40", t_to: "14:30", zona: "ischia",       pickup: "07:20", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "12:40", t_to: "14:30", zona: "lacco",        pickup: "07:10", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "12:40", t_to: "14:30", zona: "casamicciola", pickup: "07:15", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "12:40", t_to: "14:30", zona: "barano",       pickup: "07:10", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "12:40", t_to: "14:30", zona: "forio",        pickup: "07:00", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 3 — volo 14:45→17:55
  { transport_type: "volo_traghetto", t_from: "14:45", t_to: "17:55", zona: "ischia",       pickup: "08:40", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "14:45", t_to: "17:55", zona: "lacco",        pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "14:45", t_to: "17:55", zona: "casamicciola", pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "14:45", t_to: "17:55", zona: "barano",       pickup: "08:15", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "14:45", t_to: "17:55", zona: "forio",        pickup: "08:30", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // slot 4 — volo 18:00→23:55
  { transport_type: "volo_traghetto", t_from: "18:00", t_to: "23:55", zona: "ischia",       pickup: "12:30", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "18:00", t_to: "23:55", zona: "lacco",        pickup: "12:30", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "18:00", t_to: "23:55", zona: "casamicciola", pickup: "12:40", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "18:00", t_to: "23:55", zona: "barano",       pickup: "12:15", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "volo_traghetto", t_from: "18:00", t_to: "23:55", zona: "forio",        pickup: "12:15", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
];

// ---------------------------------------------------------------------------
// VOLO + ALISCAFO  (ALILAURO / SNAV — Napoli)
// ---------------------------------------------------------------------------
const VOLO_ALISCAFO: PickupRule[] = [
  // slot 1 — 09:35→11:25  ALILAURO 06:30 Napoli→Ischia
  { transport_type: "volo_aliscafo", t_from: "09:35", t_to: "11:25", zona: "ischia",       pickup: "05:45", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "09:35", t_to: "11:25", zona: "lacco",        pickup: "05:30", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "09:35", t_to: "11:25", zona: "casamicciola", pickup: "05:30", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "09:35", t_to: "11:25", zona: "barano",       pickup: "05:30", boat_co: "ALILAURO", boat_t: "06:30", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  // slot 2 — 11:30→12:55  SNAV 07:10 Napoli→Casamicciola
  { transport_type: "volo_aliscafo", t_from: "11:30", t_to: "12:55", zona: "ischia",       pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "volo_aliscafo", t_from: "11:30", t_to: "12:55", zona: "lacco",        pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "11:30", t_to: "12:55", zona: "casamicciola", pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "volo_aliscafo", t_from: "11:30", t_to: "12:55", zona: "barano",       pickup: "06:15", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  // slot 3 — 13:00→13:55  ALILAURO 08:40 Napoli→Ischia
  { transport_type: "volo_aliscafo", t_from: "13:00", t_to: "13:55", zona: "ischia",       pickup: "08:00", boat_co: "ALILAURO", boat_t: "08:40", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "13:00", t_to: "13:55", zona: "lacco",        pickup: "07:45", boat_co: "ALILAURO", boat_t: "08:40", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "13:00", t_to: "13:55", zona: "casamicciola", pickup: "07:50", boat_co: "ALILAURO", boat_t: "08:40", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "13:00", t_to: "13:55", zona: "barano",       pickup: "07:45", boat_co: "ALILAURO", boat_t: "08:40", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  // slot 4 — 14:00→14:55  SNAV 09:45 Napoli→Casamicciola
  { transport_type: "volo_aliscafo", t_from: "14:00", t_to: "14:55", zona: "ischia",       pickup: "08:40", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "volo_aliscafo", t_from: "14:00", t_to: "14:55", zona: "lacco",        pickup: "08:45", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "14:00", t_to: "14:55", zona: "casamicciola", pickup: "08:45", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "volo_aliscafo", t_from: "14:00", t_to: "14:55", zona: "barano",       pickup: "08:15", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  // slot 5 — 15:00→16:55  ALILAURO 11:45 Napoli→Ischia
  { transport_type: "volo_aliscafo", t_from: "15:00", t_to: "16:55", zona: "ischia",       pickup: "11:00", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "15:00", t_to: "16:55", zona: "lacco",        pickup: "10:45", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "15:00", t_to: "16:55", zona: "casamicciola", pickup: "10:45", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "15:00", t_to: "16:55", zona: "barano",       pickup: "10:30", boat_co: "ALILAURO", boat_t: "11:45", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  // slot 6 — 17:00→19:55  SNAV 14:00 Napoli→Casamicciola
  { transport_type: "volo_aliscafo", t_from: "17:00", t_to: "19:55", zona: "ischia",       pickup: "12:30", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "volo_aliscafo", t_from: "17:00", t_to: "19:55", zona: "lacco",        pickup: "12:45", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "17:00", t_to: "19:55", zona: "casamicciola", pickup: "12:45", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "volo_aliscafo", t_from: "17:00", t_to: "19:55", zona: "barano",       pickup: "12:30", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  // slot 7 — 20:00→23:55  ALILAURO 16:15 Napoli→Ischia
  { transport_type: "volo_aliscafo", t_from: "20:00", t_to: "23:55", zona: "ischia",       pickup: "15:30", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "20:00", t_to: "23:55", zona: "lacco",        pickup: "15:15", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES },
  { transport_type: "volo_aliscafo", t_from: "20:00", t_to: "23:55", zona: "casamicciola", pickup: "15:15", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA" },
  { transport_type: "volo_aliscafo", t_from: "20:00", t_to: "23:55", zona: "barano",       pickup: "15:00", boat_co: "ALILAURO", boat_t: "16:15", porto_p: "NAPOLI", porto_a: "ISCHIA" },
];

// ---------------------------------------------------------------------------
// SNAV diretto  (tutte le agenzie)
// t_from = orario barca, t_to = null
// ---------------------------------------------------------------------------
const EXC_SNAV_VSD_GIU_SET = "Dal 1 giugno al 28 settembre: venerdì, sabato, domenica";
const EXC_SNAV_VSDI_GIU_SET = "Dal 6 giugno al 13 settembre: venerdì, sabato, domenica, lunedì";
const EXC_SNAV_15 = "Dal 2 maggio al 30 maggio: ven e dom · Dal 1 giugno al 30 settembre: tutti i giorni";

const SNAV_DIRECT: PickupRule[] = [
  // 07:10
  { transport_type: "snav", t_from: "07:10", t_to: null, zona: "ischia",       pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "07:10", t_to: null, zona: "lacco",        pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "07:10", t_to: null, zona: "casamicciola", pickup: "06:30", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "07:10", t_to: null, zona: "barano",       pickup: "06:15", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "07:10", t_to: null, zona: "forio",        pickup: "06:20", boat_co: "SNAV", boat_t: "07:10", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 09:45
  { transport_type: "snav", t_from: "09:45", t_to: null, zona: "ischia",       pickup: "08:40", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "09:45", t_to: null, zona: "lacco",        pickup: "08:45", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "09:45", t_to: null, zona: "casamicciola", pickup: "08:45", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "09:45", t_to: null, zona: "barano",       pickup: "08:15", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "09:45", t_to: null, zona: "forio",        pickup: "08:30", boat_co: "SNAV", boat_t: "09:45", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 10:30 (stagionale)
  { transport_type: "snav", t_from: "10:30", t_to: null, zona: "ischia",       pickup: "08:40", boat_co: "SNAV", boat_t: "10:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "10:30", t_to: null, zona: "lacco",        pickup: "08:45", boat_co: "SNAV", boat_t: "10:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET, notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "10:30", t_to: null, zona: "casamicciola", pickup: "08:45", boat_co: "SNAV", boat_t: "10:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "10:30", t_to: null, zona: "barano",       pickup: "08:15", boat_co: "SNAV", boat_t: "10:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "10:30", t_to: null, zona: "forio",        pickup: "08:30", boat_co: "SNAV", boat_t: "10:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET, notes: FORIO_NOTES, not_sosandra: true },
  // 12:50 (stagionale)
  { transport_type: "snav", t_from: "12:50", t_to: null, zona: "ischia",       pickup: "11:50", boat_co: "SNAV", boat_t: "12:50", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "12:50", t_to: null, zona: "lacco",        pickup: "11:50", boat_co: "SNAV", boat_t: "12:50", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET, notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "12:50", t_to: null, zona: "casamicciola", pickup: "11:50", boat_co: "SNAV", boat_t: "12:50", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "12:50", t_to: null, zona: "barano",       pickup: "11:30", boat_co: "SNAV", boat_t: "12:50", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "12:50", t_to: null, zona: "forio",        pickup: "11:45", boat_co: "SNAV", boat_t: "12:50", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET, notes: FORIO_NOTES, not_sosandra: true },
  // 13:15 (stagionale)
  { transport_type: "snav", t_from: "13:15", t_to: null, zona: "ischia",       pickup: "11:50", boat_co: "SNAV", boat_t: "13:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET },
  { transport_type: "snav", t_from: "13:15", t_to: null, zona: "lacco",        pickup: "11:50", boat_co: "SNAV", boat_t: "13:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET, notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "13:15", t_to: null, zona: "casamicciola", pickup: "11:50", boat_co: "SNAV", boat_t: "13:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET },
  { transport_type: "snav", t_from: "13:15", t_to: null, zona: "barano",       pickup: "11:30", boat_co: "SNAV", boat_t: "13:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET },
  { transport_type: "snav", t_from: "13:15", t_to: null, zona: "forio",        pickup: "11:45", boat_co: "SNAV", boat_t: "13:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET, notes: FORIO_NOTES, not_sosandra: true },
  // 14:00
  { transport_type: "snav", t_from: "14:00", t_to: null, zona: "ischia",       pickup: "12:30", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "14:00", t_to: null, zona: "lacco",        pickup: "12:40", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "14:00", t_to: null, zona: "casamicciola", pickup: "12:50", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "14:00", t_to: null, zona: "barano",       pickup: "12:00", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "14:00", t_to: null, zona: "forio",        pickup: "12:30", boat_co: "SNAV", boat_t: "14:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 15:15 (stagionale)
  { transport_type: "snav", t_from: "15:15", t_to: null, zona: "ischia",       pickup: "14:15", boat_co: "SNAV", boat_t: "15:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_15 },
  { transport_type: "snav", t_from: "15:15", t_to: null, zona: "lacco",        pickup: "14:15", boat_co: "SNAV", boat_t: "15:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_15, notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "15:15", t_to: null, zona: "casamicciola", pickup: "14:30", boat_co: "SNAV", boat_t: "15:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_15 },
  { transport_type: "snav", t_from: "15:15", t_to: null, zona: "barano",       pickup: "14:00", boat_co: "SNAV", boat_t: "15:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_15 },
  { transport_type: "snav", t_from: "15:15", t_to: null, zona: "forio",        pickup: "14:00", boat_co: "SNAV", boat_t: "15:15", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_15, notes: FORIO_NOTES, not_sosandra: true },
  // 17:40
  { transport_type: "snav", t_from: "17:40", t_to: null, zona: "ischia",       pickup: "16:45", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "17:40", t_to: null, zona: "lacco",        pickup: "16:50", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "17:40", t_to: null, zona: "casamicciola", pickup: "16:50", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "17:40", t_to: null, zona: "barano",       pickup: "16:30", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA" },
  { transport_type: "snav", t_from: "17:40", t_to: null, zona: "forio",        pickup: "16:45", boat_co: "SNAV", boat_t: "17:40", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 18:30 (stagionale)
  { transport_type: "snav", t_from: "18:30", t_to: null, zona: "ischia",       pickup: "17:15", boat_co: "SNAV", boat_t: "18:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "18:30", t_to: null, zona: "lacco",        pickup: "17:30", boat_co: "SNAV", boat_t: "18:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET, notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "18:30", t_to: null, zona: "casamicciola", pickup: "17:30", boat_co: "SNAV", boat_t: "18:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "18:30", t_to: null, zona: "barano",       pickup: "17:00", boat_co: "SNAV", boat_t: "18:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET },
  { transport_type: "snav", t_from: "18:30", t_to: null, zona: "forio",        pickup: "16:45", boat_co: "SNAV", boat_t: "18:30", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSD_GIU_SET, notes: FORIO_NOTES, not_sosandra: true },
  // 20:00 (stagionale)
  { transport_type: "snav", t_from: "20:00", t_to: null, zona: "ischia",       pickup: "19:00", boat_co: "SNAV", boat_t: "20:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET },
  { transport_type: "snav", t_from: "20:00", t_to: null, zona: "lacco",        pickup: "19:00", boat_co: "SNAV", boat_t: "20:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET, notes: LACCO_NOTES },
  { transport_type: "snav", t_from: "20:00", t_to: null, zona: "casamicciola", pickup: "19:00", boat_co: "SNAV", boat_t: "20:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET },
  { transport_type: "snav", t_from: "20:00", t_to: null, zona: "barano",       pickup: "19:00", boat_co: "SNAV", boat_t: "20:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET },
  { transport_type: "snav", t_from: "20:00", t_to: null, zona: "forio",        pickup: "19:00", boat_co: "SNAV", boat_t: "20:00", porto_p: "NAPOLI", porto_a: "CASAMICCIOLA", exc: EXC_SNAV_VSDI_GIU_SET, notes: FORIO_NOTES, not_sosandra: true },
];

// ---------------------------------------------------------------------------
// MEDMAR diretto  (non SOSANDRA)
// ---------------------------------------------------------------------------
const MEDMAR_DIRECT: PickupRule[] = [
  // --- Napoli → Ischia ---
  // 06:25
  { transport_type: "medmar", t_from: "06:25", t_to: null, zona: "ischia",       pickup: "05:30", boat_co: "MEDMAR", boat_t: "06:25", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "06:25", t_to: null, zona: "lacco",        pickup: "05:20", boat_co: "MEDMAR", boat_t: "06:25", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "06:25", t_to: null, zona: "casamicciola", pickup: "05:30", boat_co: "MEDMAR", boat_t: "06:25", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "06:25", t_to: null, zona: "barano",       pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:25", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "06:25", t_to: null, zona: "forio",        pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:25", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // 10:35
  { transport_type: "medmar", t_from: "10:35", t_to: null, zona: "ischia",       pickup: "08:40", boat_co: "MEDMAR", boat_t: "10:35", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "10:35", t_to: null, zona: "lacco",        pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:35", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "10:35", t_to: null, zona: "casamicciola", pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:35", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "10:35", t_to: null, zona: "barano",       pickup: "08:15", boat_co: "MEDMAR", boat_t: "10:35", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "10:35", t_to: null, zona: "forio",        pickup: "08:30", boat_co: "MEDMAR", boat_t: "10:35", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // 17:00
  { transport_type: "medmar", t_from: "17:00", t_to: null, zona: "ischia",       pickup: "15:30", boat_co: "MEDMAR", boat_t: "17:00", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "17:00", t_to: null, zona: "lacco",        pickup: "15:30", boat_co: "MEDMAR", boat_t: "17:00", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "17:00", t_to: null, zona: "casamicciola", pickup: "15:30", boat_co: "MEDMAR", boat_t: "17:00", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "17:00", t_to: null, zona: "barano",       pickup: "15:15", boat_co: "MEDMAR", boat_t: "17:00", porto_p: "NAPOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "17:00", t_to: null, zona: "forio",        pickup: "15:15", boat_co: "MEDMAR", boat_t: "17:00", porto_p: "NAPOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // --- Pozzuoli → Casamicciola ---
  // 06:20
  { transport_type: "medmar", t_from: "06:20", t_to: null, zona: "ischia",       pickup: "05:30", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "06:20", t_to: null, zona: "lacco",        pickup: "05:20", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "06:20", t_to: null, zona: "casamicciola", pickup: "05:30", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "06:20", t_to: null, zona: "barano",       pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "06:20", t_to: null, zona: "forio",        pickup: "05:00", boat_co: "MEDMAR", boat_t: "06:20", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 08:10 Pozzuoli→Ischia
  { transport_type: "medmar", t_from: "08:10", t_to: null, zona: "ischia",       pickup: "07:20", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "08:10", t_to: null, zona: "lacco",        pickup: "07:10", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "08:10", t_to: null, zona: "casamicciola", pickup: "07:15", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "08:10", t_to: null, zona: "barano",       pickup: "07:10", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "08:10", t_to: null, zona: "forio",        pickup: "07:00", boat_co: "MEDMAR", boat_t: "08:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // 10:10 Pozzuoli→Casamicciola
  { transport_type: "medmar", t_from: "10:10", t_to: null, zona: "ischia",       pickup: "08:40", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "10:10", t_to: null, zona: "lacco",        pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "10:10", t_to: null, zona: "casamicciola", pickup: "08:45", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "10:10", t_to: null, zona: "barano",       pickup: "08:15", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "10:10", t_to: null, zona: "forio",        pickup: "08:30", boat_co: "MEDMAR", boat_t: "10:10", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 13:35 Pozzuoli→Casamicciola
  { transport_type: "medmar", t_from: "13:35", t_to: null, zona: "ischia",       pickup: "12:30", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "13:35", t_to: null, zona: "lacco",        pickup: "12:45", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "13:35", t_to: null, zona: "casamicciola", pickup: "12:45", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "13:35", t_to: null, zona: "barano",       pickup: "12:00", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "13:35", t_to: null, zona: "forio",        pickup: "12:30", boat_co: "MEDMAR", boat_t: "13:35", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 16:50 Pozzuoli→Casamicciola
  { transport_type: "medmar", t_from: "16:50", t_to: null, zona: "ischia",       pickup: "15:30", boat_co: "MEDMAR", boat_t: "16:50", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "16:50", t_to: null, zona: "lacco",        pickup: "15:30", boat_co: "MEDMAR", boat_t: "16:50", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "16:50", t_to: null, zona: "casamicciola", pickup: "15:30", boat_co: "MEDMAR", boat_t: "16:50", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "16:50", t_to: null, zona: "barano",       pickup: "15:15", boat_co: "MEDMAR", boat_t: "16:50", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", not_sosandra: true },
  { transport_type: "medmar", t_from: "16:50", t_to: null, zona: "forio",        pickup: "15:15", boat_co: "MEDMAR", boat_t: "16:50", porto_p: "POZZUOLI", porto_a: "CASAMICCIOLA", notes: FORIO_NOTES, not_sosandra: true },
  // 11:10 Pozzuoli→Ischia
  { transport_type: "medmar", t_from: "11:10", t_to: null, zona: "ischia",       pickup: "09:30", boat_co: "MEDMAR", boat_t: "11:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "11:10", t_to: null, zona: "lacco",        pickup: "08:40", boat_co: "MEDMAR", boat_t: "11:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "11:10", t_to: null, zona: "casamicciola", pickup: "08:45", boat_co: "MEDMAR", boat_t: "11:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "11:10", t_to: null, zona: "barano",       pickup: "09:00", boat_co: "MEDMAR", boat_t: "11:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "11:10", t_to: null, zona: "forio",        pickup: "08:30", boat_co: "MEDMAR", boat_t: "11:10", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
  // 15:00 Pozzuoli→Ischia
  { transport_type: "medmar", t_from: "15:00", t_to: null, zona: "ischia",       pickup: "14:00", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "15:00", t_to: null, zona: "lacco",        pickup: "14:00", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: LACCO_NOTES, not_sosandra: true },
  { transport_type: "medmar", t_from: "15:00", t_to: null, zona: "casamicciola", pickup: "14:00", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "15:00", t_to: null, zona: "barano",       pickup: "13:45", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", not_sosandra: true },
  { transport_type: "medmar", t_from: "15:00", t_to: null, zona: "forio",        pickup: "13:45", boat_co: "MEDMAR", boat_t: "15:00", porto_p: "POZZUOLI", porto_a: "ISCHIA", notes: FORIO_NOTES, not_sosandra: true },
];

// ---------------------------------------------------------------------------
// Indice completo
// ---------------------------------------------------------------------------
export const ALL_PICKUP_RULES: PickupRule[] = [
  ...TRENO_TRAGHETTO,
  ...TRENO_ALISCAFO,
  ...VOLO_TRAGHETTO,
  ...VOLO_ALISCAFO,
  ...SNAV_DIRECT,
  ...MEDMAR_DIRECT,
];

// ---------------------------------------------------------------------------
// Normalizzazione nome agenzia → chiave
// ---------------------------------------------------------------------------
export function normalizeAgencyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSosandra(agencyKey: string): boolean {
  return agencyKey.includes("sosandra");
}

// ---------------------------------------------------------------------------
// Lookup principale
//
// transportType: 'treno_traghetto' | 'treno_aliscafo' | 'volo_traghetto' |
//                'volo_aliscafo' | 'snav' | 'medmar'
// tFrom: orario partenza treno/volo/barca  (HH:MM)
// zona:  zona hotel su Ischia (ischia | lacco | casamicciola | barano | forio)
// ---------------------------------------------------------------------------
export function getPickupRule(
  agencyName: string,
  transportType: string,
  tFrom: string,
  zona: string
): PickupRule | null {
  const key = normalizeAgencyKey(agencyName);
  const sosandra = isSosandra(key);
  const z = zona.toLowerCase().trim();
  const tf = tFrom.trim();

  return ALL_PICKUP_RULES.find((r) => {
    if (r.not_sosandra && sosandra) return false;
    if (r.transport_type !== transportType) return false;
    if (r.t_from !== tf) return false;
    if (r.zona !== z) return false;
    return true;
  }) ?? null;
}

// ---------------------------------------------------------------------------
// Lookup con fascia oraria treno/volo (dato t_from + t_to del biglietto)
// Trova la riga il cui t_from coincide con l'orario di partenza del treno/volo.
// ---------------------------------------------------------------------------
export function getPickupRuleByTransportDeparture(
  agencyName: string,
  transportType: string,
  transportDeparture: string,  // orario di partenza del treno/volo (HH:MM)
  zona: string
): PickupRule | null {
  return getPickupRule(agencyName, transportType, transportDeparture, zona);
}

// ---------------------------------------------------------------------------
// Lookup per fascia: dato l'orario effettivo della connessione (treno/volo/bus)
// trova lo slot in cui quell'orario cade (t_from ≤ connectionTime ≤ t_to).
// Usato per FlixBus e qualsiasi connessione con orario non coincidente con
// il t_from esatto della regola.
// ---------------------------------------------------------------------------
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.trim().split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function getPickupRuleByRange(
  agencyName: string,
  transportType: string,
  connectionTime: string,  // orario reale di partenza del mezzo (HH:MM)
  zona: string
): PickupRule | null {
  const key = normalizeAgencyKey(agencyName);
  const sosandra = isSosandra(key);
  const z = zona.toLowerCase().trim();
  const connMin = toMinutes(connectionTime);

  return ALL_PICKUP_RULES.find((r) => {
    if (r.not_sosandra && sosandra) return false;
    if (r.transport_type !== transportType) return false;
    if (r.zona !== z) return false;
    if (r.t_to === null) return false; // SNAV/MEDMAR diretti usano t_from esatto
    return connMin >= toMinutes(r.t_from) && connMin <= toMinutes(r.t_to);
  }) ?? null;
}

// ---------------------------------------------------------------------------
// Lookup inverso: dato l'orario di prelevamento hotel (pickup), trova la regola.
// Usato quando nel DB è memorizzato solo il pickup sull'isola (non l'orario volo/treno).
// Non filtra per agenzia perché usato esclusivamente per le liste Bruno.
// ---------------------------------------------------------------------------
export function getPickupRuleByIslandPickup(
  transportType: string,
  pickupTime: string,
  zona: string
): PickupRule | null {
  const z = zona.toLowerCase().trim();
  const pt = pickupTime.trim();
  return ALL_PICKUP_RULES.find((r) => {
    if (r.transport_type !== transportType) return false;
    if (r.zona !== z) return false;
    return r.pickup === pt;
  }) ?? null;
}

// ---------------------------------------------------------------------------
// Elenca tutte le opzioni disponibili per tipo di trasporto + zona
// (utile per mostrare un selettore di orari nell'UI)
// ---------------------------------------------------------------------------
export function listAvailableDepartures(
  agencyName: string,
  transportType: string,
  zona: string
): PickupRule[] {
  const key = normalizeAgencyKey(agencyName);
  const sosandra = isSosandra(key);
  const z = zona.toLowerCase().trim();

  return ALL_PICKUP_RULES.filter((r) => {
    if (r.not_sosandra && sosandra) return false;
    if (r.transport_type !== transportType) return false;
    if (r.zona !== z) return false;
    return true;
  });
}
