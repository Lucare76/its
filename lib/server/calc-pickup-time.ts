/**
 * Calcolo automatico orario pickup e corsa barca per i ritorni.
 *
 * Regole operative (dal documento operativo del cliente):
 * - Input:  agenzia, tipo mezzo (treno/aereo), tipo barca (traghetto/aliscafo), orario treno/volo
 * - Output: pickup_hotel, barca_compagnia, orario_barca, porto_bruno, alert
 *
 * Note:
 * - Aleste Viaggi è SEMPRE traghetto (anche se non specificato)
 * - Dimhotels = Sosandra Tour (agency_key: sosandra)
 * - Per voli con orario ≤ 09:30 → alert PARTIRE GIORNO PRIMA
 */

export type PickupResult = {
  pickup_hotel: string | null;       // orario prelievo dall'hotel (HH:MM)
  barca_compagnia: string | null;    // Medmar | Alilauro | Snav
  orario_barca: string | null;       // orario partenza barca da Ischia (HH:MM)
  porto_bruno: string | null;        // dove Bruno raccoglie il cliente
  alert: string | null;              // testo alert se necessario
};

type RulesInput = {
  agency_key: string;   // 'aleste' | 'sosandra' | 'angelino' | 'holidayweb' | 'zigolo' | 'unknown'
  mezzo: "treno" | "aereo";
  tipo_barca: "traghetto" | "aliscafo";
  orario: string;       // HH:MM orario treno/volo
};

// Converte "HH:MM" in minuti dall'inizio della giornata
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Controlla se orario è nella fascia [da, a] inclusi
function inFascia(orario: string, da: string, a: string): boolean {
  const t = toMinutes(orario);
  const from = toMinutes(da);
  const to = a === "24:00" ? 24 * 60 : toMinutes(a);
  return t >= from && t <= to;
}

// ─── Regole Aleste (e tutte le agenzie non-dimhotels) ────────────────────────
// Aleste è sempre traghetto → Medmar. Le fasce danno pickup_hotel.
// Porto Bruno = Napoli Beverello (Medmar traghetto)

const ALESTE_TRENO_TRAGHETTO: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }> = [
  { da: "09:00", a: "10:55", pickup: "07:20", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "11:00", a: "13:15", pickup: "09:00", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "13:20", a: "16:50", pickup: "11:00", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "16:55", a: "18:40", pickup: "14:35", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "18:45", a: "24:00", pickup: "16:00", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
];

const ALESTE_AEREO_TRAGHETTO: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }> = [
  { da: "10:00", a: "12:30", pickup: "07:20", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "12:40", a: "14:30", pickup: "09:10", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "14:45", a: "17:55", pickup: "11:10", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
  { da: "18:00", a: "24:00", pickup: "14:45", barca: "Medmar", orario_barca: "", porto: "Napoli Beverello" },
];

// ─── Regole Dimhotels/Sosandra — TRAGHETTO (Medmar) ─────────────────────────
// Le fasce danno orario_barca (Flight Medmar), non pickup_hotel

const DIMHOTELS_TRENO_TRAGHETTO: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }> = [
  { da: "09:00", a: "10:55", pickup: "", barca: "Medmar", orario_barca: "06:20", porto: "Napoli Beverello" },
  { da: "11:00", a: "13:10", pickup: "", barca: "Medmar", orario_barca: "08:10", porto: "Napoli Beverello" },
  { da: "13:15", a: "16:50", pickup: "", barca: "Medmar", orario_barca: "10:10", porto: "Napoli Beverello" },
  { da: "16:55", a: "18:40", pickup: "", barca: "Medmar", orario_barca: "13:35", porto: "Napoli Beverello" },
  { da: "18:45", a: "24:00", pickup: "", barca: "Medmar", orario_barca: "15:00", porto: "Napoli Beverello" },
];

const DIMHOTELS_AEREO_TRAGHETTO: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }> = [
  { da: "10:00", a: "12:30", pickup: "", barca: "Medmar", orario_barca: "06:20", porto: "Napoli Beverello" },
  { da: "12:40", a: "14:30", pickup: "", barca: "Medmar", orario_barca: "08:10", porto: "Napoli Beverello" },
  { da: "14:45", a: "17:55", pickup: "", barca: "Medmar", orario_barca: "10:10", porto: "Napoli Beverello" },
  { da: "18:00", a: "24:00", pickup: "", barca: "Medmar", orario_barca: "13:35", porto: "Napoli Beverello" },
];

// ─── Regole Dimhotels/Sosandra — ALISCAFO (Alilauro/Snav alternati) ──────────
// Treno
const DIMHOTELS_TRENO_ALISCAFO: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }> = [
  { da: "08:30", a: "09:25", pickup: "", barca: "Alilauro", orario_barca: "06:30", porto: "Napoli Beverello" },
  { da: "09:30", a: "10:40", pickup: "", barca: "Snav",     orario_barca: "07:10", porto: "Pozzuoli" },
  { da: "10:45", a: "11:55", pickup: "", barca: "Alilauro", orario_barca: "08:40", porto: "Napoli Beverello" },
  { da: "12:00", a: "13:40", pickup: "", barca: "Snav",     orario_barca: "09:45", porto: "Pozzuoli" },
  { da: "13:45", a: "16:10", pickup: "", barca: "Alilauro", orario_barca: "11:45", porto: "Napoli Beverello" },
  { da: "16:15", a: "18:10", pickup: "", barca: "Snav",     orario_barca: "14:00", porto: "Pozzuoli" },
  { da: "18:15", a: "19:55", pickup: "", barca: "Alilauro", orario_barca: "16:15", porto: "Napoli Beverello" },
  { da: "20:00", a: "24:00", pickup: "", barca: "Alilauro", orario_barca: "16:15", porto: "Napoli Beverello" },
];

// Aereo
const DIMHOTELS_AEREO_ALISCAFO: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }> = [
  { da: "09:35", a: "11:25", pickup: "", barca: "Alilauro", orario_barca: "06:30", porto: "Napoli Beverello" },
  { da: "11:30", a: "12:55", pickup: "", barca: "Snav",     orario_barca: "07:10", porto: "Pozzuoli" },
  { da: "12:30", a: "13:55", pickup: "", barca: "Alilauro", orario_barca: "08:40", porto: "Napoli Beverello" },
  { da: "14:00", a: "14:55", pickup: "", barca: "Snav",     orario_barca: "09:45", porto: "Pozzuoli" },
  { da: "15:00", a: "16:55", pickup: "", barca: "Alilauro", orario_barca: "11:45", porto: "Napoli Beverello" },
  { da: "17:00", a: "19:55", pickup: "", barca: "Snav",     orario_barca: "14:00", porto: "Pozzuoli" },
  { da: "20:00", a: "23:00", pickup: "", barca: "Alilauro", orario_barca: "16:15", porto: "Napoli Beverello" },
];

// Aliscafo Dimhotels — treno (pickup dall'hotel, stesso schema del treno)
const DIMHOTELS_TRENO_ALISCAFO_PICKUP: Array<{ da: string; a: string; pickup: string }> = [
  { da: "08:30", a: "09:25", pickup: "07:15" },
  { da: "09:30", a: "10:40", pickup: "09:10" },
  { da: "10:45", a: "11:55", pickup: "10:45" },
  { da: "12:00", a: "13:40", pickup: "10:45" },
  { da: "13:45", a: "16:10", pickup: "12:30" },
  { da: "16:15", a: "18:10", pickup: "15:00" },
  { da: "18:15", a: "19:55", pickup: "17:00" },
  { da: "20:00", a: "24:00", pickup: "18:40" },
];

// Aliscafo Dimhotels — aereo
const DIMHOTELS_AEREO_ALISCAFO_PICKUP: Array<{ da: string; a: string; pickup: string }> = [
  { da: "09:35", a: "11:25", pickup: "07:15" },
  { da: "11:30", a: "12:55", pickup: "08:10" },
  { da: "12:30", a: "13:55", pickup: "09:25" },
  { da: "14:00", a: "14:55", pickup: "10:45" },
  { da: "15:00", a: "16:55", pickup: "12:45" },
  { da: "17:00", a: "19:55", pickup: "15:00" },
  { da: "20:00", a: "23:00", pickup: "17:15" },
];

// ─── Funzione principale ──────────────────────────────────────────────────────

export function calcPickupTime(input: RulesInput): PickupResult {
  const { agency_key, mezzo, tipo_barca, orario } = input;

  // Alert universale: volo prima delle 09:30
  if (mezzo === "aereo" && toMinutes(orario) <= toMinutes("09:30")) {
    return {
      pickup_hotel: null,
      barca_compagnia: null,
      orario_barca: null,
      porto_bruno: null,
      alert: "⚠️ PARTIRE GIORNO PRIMA — volo alle " + orario
    };
  }

  const isDimhotels = agency_key === "sosandra";
  // Aleste è sempre traghetto anche se non specificato
  const effectiveBarca = agency_key === "aleste" ? "traghetto" : tipo_barca;

  // Seleziona la tabella giusta
  let table: Array<{ da: string; a: string; pickup: string; barca: string; orario_barca: string; porto: string }>;
  let pickupTable: Array<{ da: string; a: string; pickup: string }> | null = null;

  if (isDimhotels) {
    if (mezzo === "treno" && effectiveBarca === "traghetto") table = DIMHOTELS_TRENO_TRAGHETTO;
    else if (mezzo === "aereo" && effectiveBarca === "traghetto") table = DIMHOTELS_AEREO_TRAGHETTO;
    else if (mezzo === "treno" && effectiveBarca === "aliscafo") {
      table = DIMHOTELS_TRENO_ALISCAFO;
      pickupTable = DIMHOTELS_TRENO_ALISCAFO_PICKUP;
    } else {
      table = DIMHOTELS_AEREO_ALISCAFO;
      pickupTable = DIMHOTELS_AEREO_ALISCAFO_PICKUP;
    }
  } else {
    // Tutte le altre agenzie — stessa logica Aleste
    if (mezzo === "treno") table = ALESTE_TRENO_TRAGHETTO;
    else table = ALESTE_AEREO_TRAGHETTO;
  }

  // Lookup nella tabella
  const row = table.find((r) => inFascia(orario, r.da, r.a));
  if (!row) {
    return { pickup_hotel: null, barca_compagnia: null, orario_barca: null, porto_bruno: null, alert: "Fascia oraria non trovata per " + orario };
  }

  // Per dimhotels aliscafo, pickup viene da tabella separata
  let pickup = row.pickup;
  if (pickupTable) {
    const pr = pickupTable.find((r) => inFascia(orario, r.da, r.a));
    pickup = pr?.pickup ?? "";
  }

  return {
    pickup_hotel: pickup || null,
    barca_compagnia: row.barca,
    orario_barca: row.orario_barca || null,
    porto_bruno: row.porto,
    alert: null
  };
}
