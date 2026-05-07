import XLSX from "xlsx";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "templates", "import-servizi-place-based.xlsx");

const headers = [
  "Categoria servizio",
  "Tipo tratta",
  "Data servizio",
  "Ora servizio",
  "Origine",
  "Tipo origine",
  "Destinazione",
  "Tipo destinazione",
  "Hotel",
  "Zona hotel",
  "Nome cliente",
  "Pax",
  "Telefono",
  "Agenzia",
  "Riferimento viaggio",
  "Compagnia / mezzo",
  "Ora imbarco",
  "Ora arrivo Ischia",
  "Ora pickup",
  "Nome escursione",
  "Pratica",
  "Note operative",
  "Data arrivo bus",
  "Ora arrivo bus",
  "Data ritorno bus",
  "Ora ritorno bus",
  "Linea bus",
  "Fermata / città partenza",
  "Codice fermata",
  "Hotel destinazione bus",
  "Pickup ritorno"
];

const emptyBus = ["", "", "", "", "", "", "", "", ""];

const rows = [
  headers,
  [
    "Arrivo", "porto_hotel", "2026-06-15", "11:30", "Porto Ischia", "porto", "Hotel Bellevue", "hotel",
    "Hotel Bellevue", "Ischia Porto", "Mario Rossi", 2, "3331111111", "TEST", "SNAV 10:40", "SNAV",
    "10:40", "11:30", "11:35", "", "DEMO-001", "Arrivo porto hotel", ...emptyBus
  ],
  [
    "Partenza", "hotel_porto", "2026-06-16", "08:30", "Hotel Bellevue", "hotel", "Porto Ischia", "porto",
    "Hotel Bellevue", "Ischia Porto", "Anna Bianchi", 2, "3332222222", "TEST", "MEDMAR 09:45", "MEDMAR",
    "09:45", "", "08:30", "", "DEMO-002", "Partenza hotel porto", ...emptyBus
  ],
  [
    "Transfer", "hotel_aeroporto", "2026-06-17", "07:00", "Hotel Bellevue", "hotel", "Aeroporto Napoli", "aeroporto",
    "Hotel Bellevue", "Ischia Porto", "Luca Verdi", 3, "3333333333", "TEST", "Volo AZ123", "Aereo",
    "", "", "07:00", "", "DEMO-003", "Hotel aeroporto", ...emptyBus
  ],
  [
    "Escursione", "escursione", "2026-06-18", "09:00", "Porto Ischia", "porto", "Procida", "località",
    "", "Procida", "Giulia Neri", 2, "3334444444", "TEST", "", "Barca",
    "09:15", "", "09:00", "Procida", "DEMO-004", "Escursione Procida", ...emptyBus
  ],
  [
    "Territoriale", "luogo_luogo", "2026-06-19", "10:00", "Lacco Ameno", "località", "Mortella", "attrazione",
    "", "Lacco Ameno", "Paolo Blu", 2, "3335555555", "TEST", "", "Van",
    "", "", "10:00", "", "DEMO-005", "Lacco Ameno verso Mortella", ...emptyBus
  ],
  [
    "Linea Bus", "linea_bus_solo_arrivo", "", "", "", "", "", "",
    "", "", "TEST BUS TEMPLATE", 2, "3330000000", "TEST", "", "",
    "", "", "", "", "BUS-001", "Esempio Linea Bus Italia",
    "2026-06-15", "08:00", "", "", "Italia", "FELTRE", "FELTRE", "Hotel Bellevue", ""
  ],
  [
    "Linea Bus", "linea_bus_arrivo_ritorno", "", "", "", "", "", "",
    "", "", "TEST BUS A/R", 2, "3330000001", "TEST", "", "",
    "", "", "", "", "BUS-002", "Esempio Linea Bus arrivo/ritorno",
    "2026-06-15", "08:00", "2026-06-22", "09:00", "Italia", "FELTRE", "FELTRE", "Hotel Bellevue", "07:15 hotel"
  ]
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!cols"] = headers.map((header) => ({ wch: Math.max(14, header.length + 2) }));
XLSX.utils.book_append_sheet(wb, ws, "Import servizi");

const legenda = [
  ["Categoria servizio", "Arrivo | Partenza | Transfer | Escursione | Territoriale | Linea Bus"],
  ["Tipo tratta normali", "porto_hotel | hotel_porto | aeroporto_hotel | hotel_aeroporto | stazione_hotel | hotel_stazione | luogo_luogo | hotel_luogo | luogo_hotel | hotel_attrazione | attrazione_hotel | escursione"],
  ["Tipo tratta Linea Bus", "linea_bus_arrivo_ritorno | linea_bus_solo_arrivo | linea_bus_solo_ritorno"],
  ["Tipo origine / destinazione", "hotel | porto | aeroporto | stazione | località | attrazione | indirizzo | fermata_bus | altro"],
  ["Linea bus", "Italia | Centro | Adriatica"],
  ["Regola Linea Bus", "Se Categoria servizio = Linea Bus, compilare le colonne bus dedicate. Il sistema usa resolver bus e non crea transfer normali."],
  ["Regola servizi normali", "Arrivo, Partenza, Transfer, Escursione e Territoriale usano Origine/Destinazione e catalogo places. Non creano tenant_bus_allocations."],
  ["Nota", "Origine e destinazione vengono matchate sul catalogo places. Se non trovate, la riga va in errore/review e non crea hotel automatici."]
];
const wsLegenda = XLSX.utils.aoa_to_sheet(legenda);
wsLegenda["!cols"] = [{ wch: 28 }, { wch: 180 }];
XLSX.utils.book_append_sheet(wb, wsLegenda, "Legenda");

XLSX.writeFile(wb, outPath);
console.log(`Template creato: ${outPath}`);
