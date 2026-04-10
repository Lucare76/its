const XLSX = require("xlsx");
const path = require("path");

const wb = XLSX.utils.book_new();

// ─── LEGENDA ────────────────────────────────────────────────────────────────
const legenda = [
  ["TABELLA OPERATIVA ISCHIA TRANSFER — ISTRUZIONI"],
  [""],
  ["Questo file contiene le regole operative per calcolare automaticamente:"],
  ["  • A che ora prelevare il cliente dall'hotel (partenze)"],
  ["  • Quale barca prendere e a che ora (partenze e arrivi)"],
  ["  • Dove Bruno raccoglie il cliente (partenze)"],
  ["  • A che ora il bus di Ischia è al porto (arrivi)"],
  [""],
  ["FOGLIO PARTENZE — Colonne:"],
  ["  agenzia          → aleste / dimhotels / tutti  (tutti = vale per tutte le agenzie)"],
  ["  mezzo            → treno  (include bus, Flixbus, Italo, Trenitalia) / aereo"],
  ["  tipo_barca       → traghetto / aliscafo  (Aleste è SEMPRE traghetto)"],
  ["  treno_volo_da    → inizio fascia oraria treno/volo (es. 11:00)"],
  ["  treno_volo_a     → fine fascia oraria treno/volo (es. 13:15)"],
  ["  pickup_hotel     → orario prelievo cliente dall'hotel su Ischia"],
  ["  barca_compagnia  → Medmar / Alilauro / Snav"],
  ["  orario_barca     → orario partenza barca da Ischia Porto"],
  ["  porto_bruno      → dove Bruno prende il cliente: Napoli Beverello / Pozzuoli / Napoli Calata"],
  ["  alert            → testo libero (es: PARTIRE GIORNO PRIMA)"],
  [""],
  ["FOGLIO ARRIVI — Colonne:"],
  ["  agenzia          → aleste / dimhotels / tutti"],
  ["  mezzo            → treno / aereo"],
  ["  tipo_barca       → traghetto / aliscafo"],
  ["  treno_volo_da    → inizio fascia oraria arrivo treno/volo a Napoli (es. 10:00)"],
  ["  treno_volo_a     → fine fascia oraria arrivo treno/volo a Napoli (es. 12:30)"],
  ["  barca_compagnia  → Medmar / Alilauro / Snav"],
  ["  orario_barca_napoli → orario partenza barca da Napoli verso Ischia"],
  ["  orario_arrivo_ischia → orario arrivo barca a Ischia Porto"],
  ["  orario_prelevamento → orario in cui il bus di Ischia è al porto ad aspettarli"],
  ["  porto_ischia     → porto di arrivo a Ischia (Ischia Porto / Casamicciola / Forio)"],
  ["  zona_hotel       → zona dell'hotel per assegnare il bus corretto (es. Ischia, Forio, Lacco)"],
  ["  alert            → testo libero"],
  [""],
  ["NOTE IMPORTANTI:"],
  ["  • Aleste Viaggi è SEMPRE traghetto (anche se non specificato), sia andata che ritorno"],
  ["  • Per voli in ritorno con orario fino alle 09:30 → alert PARTIRE GIORNO PRIMA"],
  ["  • Snav arriva a Pozzuoli → Bruno raccoglie a Pozzuoli"],
  ["  • Medmar e Alilauro arrivano a Napoli Beverello → Bruno raccoglie a Napoli"],
  ["  • Le fasce orarie sono INCLUSE agli estremi (es. 11:00-13:15 include 13:15)"],
];

const wsLegenda = XLSX.utils.aoa_to_sheet(legenda);
wsLegenda["!cols"] = [{ wch: 90 }];
wsLegenda["A1"].s = { font: { bold: true, sz: 14 } };
XLSX.utils.book_append_sheet(wb, wsLegenda, "LEGENDA");

// ─── PARTENZE ────────────────────────────────────────────────────────────────
const partenze = [
  // Intestazione
  ["agenzia", "mezzo", "tipo_barca", "treno_volo_da", "treno_volo_a", "pickup_hotel", "barca_compagnia", "orario_barca", "porto_bruno", "alert"],
  // Descrizione colonne (riga 2)
  ["es: aleste / dimhotels / tutti", "treno / aereo", "traghetto / aliscafo", "HH:MM", "HH:MM", "HH:MM", "Medmar / Alilauro / Snav", "HH:MM", "Napoli Beverello / Pozzuoli", "testo libero"],
  ["", "", "", "", "", "", "", "", "", ""],

  // ALESTE — TRENO — TRAGHETTO (sempre Medmar per Aleste)
  ["aleste", "treno", "traghetto", "09:00", "10:55", "07:20", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "treno", "traghetto", "11:00", "13:15", "09:00", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "treno", "traghetto", "13:20", "16:50", "11:00", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "treno", "traghetto", "16:55", "18:40", "14:35", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "treno", "traghetto", "18:45", "24:00", "16:00", "Medmar", "", "Napoli Beverello", ""],
  ["", "", "", "", "", "", "", "", "", ""],

  // ALESTE — AEREO — TRAGHETTO
  ["aleste", "aereo", "traghetto", "10:00", "12:30", "07:20", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "aereo", "traghetto", "12:40", "14:30", "09:10", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "aereo", "traghetto", "14:45", "17:55", "11:10", "Medmar", "", "Napoli Beverello", ""],
  ["aleste", "aereo", "traghetto", "18:00", "24:00", "14:45", "Medmar", "", "Napoli Beverello", ""],
  ["tutti", "aereo", "qualsiasi", "00:00", "09:30", "", "", "", "", "PARTIRE GIORNO PRIMA"],
  ["", "", "", "", "", "", "", "", "", ""],

  // DIMHOTELS — TRENO — TRAGHETTO (Medmar — pickup + orario barca)
  ["dimhotels", "treno", "traghetto", "09:00", "10:55", "", "Medmar", "06:20", "Napoli Beverello", ""],
  ["dimhotels", "treno", "traghetto", "11:00", "13:10", "", "Medmar", "08:10", "Napoli Beverello", ""],
  ["dimhotels", "treno", "traghetto", "13:15", "16:50", "", "Medmar", "10:10", "Napoli Beverello", ""],
  ["dimhotels", "treno", "traghetto", "16:55", "18:40", "", "Medmar", "13:35", "Napoli Beverello", ""],
  ["dimhotels", "treno", "traghetto", "18:45", "24:00", "", "Medmar", "15:00", "Napoli Beverello", ""],
  ["", "", "", "", "", "", "", "", "", ""],

  // DIMHOTELS — TRENO — ALISCAFO (Alilauro / Snav alternati)
  ["dimhotels", "treno", "aliscafo", "08:30", "09:25", "", "Alilauro", "06:30", "Napoli Beverello", ""],
  ["dimhotels", "treno", "aliscafo", "09:30", "10:40", "", "Snav", "07:10", "Pozzuoli", ""],
  ["dimhotels", "treno", "aliscafo", "10:45", "11:55", "", "Alilauro", "08:40", "Napoli Beverello", ""],
  ["dimhotels", "treno", "aliscafo", "12:00", "13:40", "", "Snav", "09:45", "Pozzuoli", ""],
  ["dimhotels", "treno", "aliscafo", "13:45", "16:10", "", "Alilauro", "11:45", "Napoli Beverello", ""],
  ["dimhotels", "treno", "aliscafo", "16:15", "18:10", "", "Snav", "14:00", "Pozzuoli", ""],
  ["dimhotels", "treno", "aliscafo", "18:15", "19:55", "", "Alilauro", "16:15", "Napoli Beverello", ""],
  ["dimhotels", "treno", "aliscafo", "20:00", "24:00", "", "Alilauro", "16:15", "Napoli Beverello", ""],
  ["", "", "", "", "", "", "", "", "", ""],

  // DIMHOTELS — AEREO — TRAGHETTO (Medmar)
  ["dimhotels", "aereo", "traghetto", "10:00", "12:30", "", "Medmar", "06:20", "Napoli Beverello", ""],
  ["dimhotels", "aereo", "traghetto", "12:40", "14:30", "", "Medmar", "08:10", "Napoli Beverello", ""],
  ["dimhotels", "aereo", "traghetto", "14:45", "17:55", "", "Medmar", "10:10", "Napoli Beverello", ""],
  ["dimhotels", "aereo", "traghetto", "18:00", "24:00", "", "Medmar", "13:35", "Napoli Beverello", ""],
  ["tutti", "aereo", "qualsiasi", "00:00", "09:30", "", "", "", "", "PARTIRE GIORNO PRIMA"],
  ["", "", "", "", "", "", "", "", "", ""],

  // DIMHOTELS — AEREO — ALISCAFO
  ["dimhotels", "aereo", "aliscafo", "09:35", "11:25", "", "Alilauro", "06:30", "Napoli Beverello", ""],
  ["dimhotels", "aereo", "aliscafo", "11:30", "12:55", "", "Snav", "07:10", "Pozzuoli", ""],
  ["dimhotels", "aereo", "aliscafo", "12:30", "13:55", "", "Alilauro", "08:40", "Napoli Beverello", ""],
  ["dimhotels", "aereo", "aliscafo", "14:00", "14:55", "", "Snav", "09:45", "Pozzuoli", ""],
  ["dimhotels", "aereo", "aliscafo", "15:00", "16:55", "", "Alilauro", "11:45", "Napoli Beverello", ""],
  ["dimhotels", "aereo", "aliscafo", "17:00", "19:55", "", "Snav", "14:00", "Pozzuoli", ""],
  ["dimhotels", "aereo", "aliscafo", "20:00", "23:00", "", "Alilauro", "16:15", "Napoli Beverello", ""],
];

const wsPartenze = XLSX.utils.aoa_to_sheet(partenze);
wsPartenze["!cols"] = [
  { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
  { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 22 }
];
XLSX.utils.book_append_sheet(wb, wsPartenze, "PARTENZE");

// ─── ARRIVI ─────────────────────────────────────────────────────────────────
const arrivi = [
  // Intestazione
  ["agenzia", "mezzo", "tipo_barca", "treno_volo_da", "treno_volo_a", "barca_compagnia", "orario_barca_napoli", "orario_arrivo_ischia", "orario_prelevamento", "porto_ischia", "zona_hotel", "alert"],
  // Descrizione
  ["es: aleste / dimhotels / tutti", "treno / aereo", "traghetto / aliscafo", "HH:MM", "HH:MM", "Medmar / Alilauro / Snav", "HH:MM", "HH:MM", "HH:MM (bus al porto)", "Ischia Porto / Casamicciola / Forio", "zona destinazione hotel", "testo libero"],
  ["", "", "", "", "", "", "", "", "", "", "", ""],

  // ESEMPIO ARRIVI TRAGHETTO MEDMAR
  // (il cliente compila questi dati in base agli orari reali Medmar/Alilauro/Snav)
  ["tutti", "treno", "traghetto", "06:00", "08:30", "Medmar", "07:00", "09:30", "09:30", "Ischia Porto", "", ""],
  ["tutti", "treno", "traghetto", "08:31", "10:30", "Medmar", "09:00", "11:30", "11:30", "Ischia Porto", "", ""],
  ["tutti", "treno", "traghetto", "10:31", "12:30", "Medmar", "11:00", "13:30", "13:30", "Ischia Porto", "", ""],
  ["tutti", "treno", "traghetto", "12:31", "14:30", "Medmar", "13:00", "15:30", "15:30", "Ischia Porto", "", ""],
  ["tutti", "treno", "traghetto", "14:31", "17:00", "Medmar", "15:30", "18:00", "18:00", "Ischia Porto", "", ""],
  ["", "", "", "", "", "", "", "", "", "", "", ""],

  // ESEMPIO ARRIVI ALISCAFO ALILAURO
  ["tutti", "treno", "aliscafo", "06:00", "08:00", "Alilauro", "07:00", "08:30", "08:30", "Ischia Porto", "", ""],
  ["tutti", "treno", "aliscafo", "08:01", "10:00", "Alilauro", "09:00", "10:30", "10:30", "Ischia Porto", "", ""],
  ["tutti", "treno", "aliscafo", "10:01", "12:00", "Alilauro", "11:00", "12:30", "12:30", "Ischia Porto", "", ""],
  ["", "", "", "", "", "", "", "", "", "", "", ""],

  // ESEMPIO ARRIVI AEREO
  ["tutti", "aereo", "traghetto", "06:00", "09:00", "Medmar", "07:00", "09:30", "09:30", "Ischia Porto", "", ""],
  ["tutti", "aereo", "traghetto", "09:01", "12:00", "Medmar", "11:00", "13:30", "13:30", "Ischia Porto", "", ""],
  ["tutti", "aereo", "traghetto", "12:01", "15:00", "Medmar", "13:00", "15:30", "15:30", "Ischia Porto", "", ""],
  ["tutti", "aereo", "traghetto", "15:01", "18:00", "Medmar", "16:00", "18:30", "18:30", "Ischia Porto", "", ""],
];

const wsArrivi = XLSX.utils.aoa_to_sheet(arrivi);
wsArrivi["!cols"] = [
  { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
  { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 22 }
];
XLSX.utils.book_append_sheet(wb, wsArrivi, "ARRIVI");

// ─── Salva ───────────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, "tabella-operativa-ischia.xlsx");
XLSX.writeFile(wb, outPath);
console.log("File creato:", outPath);
