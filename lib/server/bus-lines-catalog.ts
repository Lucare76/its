export type BusLineStop = {
  city: string;
  time: string;
  pickupNote: string | null;
};

export type BusLineCatalogEntry = {
  code: string;
  name: string;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
  stops: BusLineStop[];
};

function note(value?: string) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBusText(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const BUS_LINES_2026: BusLineCatalogEntry[] = [
  {
    code: "LINEA_1_ITALIA",
    name: "Linea 1 Italia",
    validFrom: "2026-02-22",
    validTo: null,
    notes: "Per Ischia. Orari da PDF linee bus 2026.",
    stops: [
      { city: "BRESCIA", time: "05:00", pickupNote: note("Via Borgosatollo, zona Volta, distributore Eni") },
      { city: "BERGAMO", time: "05:45", pickupNote: note("Parcheggio Hotel Dei Mille") },
      { city: "MILANO", time: "06:30", pickupNote: note("Cascina Gobba Terminal Metro") },
      { city: "MELEGNANO", time: "06:45", pickupNote: note("Casello autostradale") },
      { city: "LODI", time: "07:00", pickupNote: note("Parcheggio Benet") },
      { city: "PIACENZA", time: "07:30", pickupNote: note("Parcheggio Stabilimento Iveco") },
      { city: "FIDENZA", time: "07:50", pickupNote: note("Casello autostradale") },
      { city: "PARMA", time: "08:00", pickupNote: note("Parcheggio Scambiatore") },
      { city: "REGGIO EMILIA", time: "08:30", pickupNote: note("Casello autostradale") },
      { city: "MODENA", time: "08:45", pickupNote: note("Casello autostradale nord") },
      { city: "BOLOGNA", time: "09:15", pickupNote: note("Area di servizio Cantagallo") },
      { city: "FIRENZE", time: "10:40", pickupNote: note("Hotel The Gate") },
      { city: "INCISA", time: "11:00", pickupNote: note("Casello autostradale") },
      { city: "VALDARNO", time: "11:15", pickupNote: note("Casello autostradale") },
      { city: "AREZZO", time: "11:40", pickupNote: note("Casello autostradale") },
      { city: "MONTE SAN SAVINO", time: "11:55", pickupNote: note("Casello autostradale") },
      { city: "VALDICHIANA", time: "12:10", pickupNote: note("Casello autostradale") },
      { city: "CHIUSI CHIANCIANO", time: "12:30", pickupNote: note("Casello autostradale") },
      { city: "FABRO", time: "12:45", pickupNote: note("Area di servizio") },
      { city: "ORVIETO", time: "13:00", pickupNote: note("Ristorante Food Village") },
      { city: "ORTE", time: "13:30", pickupNote: note("Hotel Tevere") },
      { city: "ROMA", time: "14:30", pickupNote: note("Area di Servizio Prenestina Ovest") },
      { city: "FROSINONE", time: "15:00", pickupNote: note("Casello autostradale") }
    ]
  },
  {
    code: "LINEA_2_PIEMONTE",
    name: "Linea 2 Piemonte",
    validFrom: "2026-03-08",
    validTo: null,
    notes: null,
    stops: [
      { city: "IVREA", time: "04:15", pickupNote: note("Casello autostradale") },
      { city: "BIELLA", time: "04:40", pickupNote: note("A.P.T. Via Lamarmora") },
      { city: "CAVAGLIA", time: "04:55", pickupNote: note("Casello autostradale") },
      { city: "VERCELLI OVEST", time: "05:00", pickupNote: note("Casello autostradale") },
      { city: "TORINO", time: "05:15", pickupNote: note("C.so Stati Uniti 17") },
      { city: "VILLANOVA", time: "05:25", pickupNote: note("Casello autostradale") },
      { city: "NOVARA", time: "05:40", pickupNote: note("Casello autostradale Punto Blu") },
      { city: "ASTI", time: "05:45", pickupNote: note("Casello autostradale est") },
      { city: "SANTHIA", time: "05:55", pickupNote: note("Casello autostradale ovest") },
      { city: "ALESSANDRIA", time: "06:00", pickupNote: note("Casello autostradale ovest") },
      { city: "TORTONA", time: "06:10", pickupNote: note("Casello autostradale") },
      { city: "VOGHERA", time: "06:20", pickupNote: note("Casello autostradale") },
      { city: "CASTEGGIO", time: "06:30", pickupNote: note("Casello autostradale") },
      { city: "CASTEL SAN GIOVANNI", time: "06:45", pickupNote: note("Casello autostradale") }
    ]
  },
  {
    code: "LINEA_3_LIGURIA",
    name: "Linea 3 Liguria",
    validFrom: "2026-04-26",
    validTo: null,
    notes: null,
    stops: [
      { city: "GENOVA", time: "06:20", pickupNote: note("Casello ovest davanti Novotel") },
      { city: "CHIAVARI", time: "06:40", pickupNote: note("Rotonda uscita autostradale") },
      { city: "LA SPEZIA", time: "07:20", pickupNote: note("Centro Commerciale La Fabbrica") },
      { city: "MASSA", time: "07:30", pickupNote: note("Uscita autostradale") }
    ]
  },
  {
    code: "LINEA_4_LOMBARDIA",
    name: "Linea 4 Lombardia",
    validFrom: null,
    validTo: null,
    notes: "Partenze come Linea Italia.",
    stops: [
      { city: "VARESE", time: "05:00", pickupNote: note("Stazione FF.SS.") },
      { city: "GALLARATE", time: "05:20", pickupNote: note("Casello autostradale") },
      { city: "BUSTO ARSIZIO", time: "05:30", pickupNote: note("Uscita autostradale, distributore Api") },
      { city: "LEGNANO", time: "05:40", pickupNote: note("Uscita autostradale") },
      { city: "LAINATE", time: "05:50", pickupNote: note("Casello autostradale") },
      { city: "RHO", time: "06:05", pickupNote: note("Casello autostradale") }
    ]
  },
  {
    code: "LINEA_5_LOMBARDIA_2",
    name: "Linea 5 Lombardia 2",
    validFrom: null,
    validTo: null,
    notes: "Partenze come Linea Italia.",
    stops: [
      { city: "LECCO", time: "04:20", pickupNote: note("Piazza Stazione FS") },
      { city: "ERBA", time: "04:45", pickupNote: note("Stazione FS") },
      { city: "COMO", time: "05:10", pickupNote: note("Piazza Matteotti") },
      { city: "SEREGNO", time: "05:30", pickupNote: note("Stazione FS") },
      { city: "MONZA", time: "05:50", pickupNote: note("Piazza Castello, pensilina bus") },
      { city: "SESTO SAN GIOVANNI", time: "06:00", pickupNote: note("Torri Ananas") },
      { city: "CREMONA", time: "07:00", pickupNote: note("Casello autostradale") }
    ]
  },
  {
    code: "LINEA_6_VENETO",
    name: "Linea 6 Veneto",
    validFrom: "2026-04-26",
    validTo: null,
    notes: null,
    stops: [
      { city: "FELTRE", time: "03:30", pickupNote: note("Foro Boario") },
      { city: "BELLUNO", time: "04:00", pickupNote: note("Stazione Ferroviaria") },
      { city: "VITTORIO VENETO", time: "04:35", pickupNote: note("Casello autostradale sud") },
      { city: "CONEGLIANO", time: "05:00", pickupNote: note("Casello autostradale") },
      { city: "TREVISO", time: "05:20", pickupNote: note("Casello autostradale sud") },
      { city: "MESTRE", time: "05:55", pickupNote: note("Rotonda Holiday Inn") },
      { city: "VICENZA", time: "06:20", pickupNote: note("Casello autostradale est") },
      { city: "ROVIGO", time: "07:30", pickupNote: note("Casello autostradale sud") },
      { city: "PADOVA", time: "07:30", pickupNote: note("Hotel Sheraton") },
      { city: "FERRARA", time: "08:00", pickupNote: note("Casello nord") }
    ]
  },
  {
    code: "LINEA_7_CENTRO",
    name: "Linea 7 Centro",
    validFrom: "2026-04-26",
    validTo: "2026-10-11",
    notes: "Disponibile anche dal 2025-12-29 al 2026-01-02.",
    stops: [
      { city: "CITTA DI CASTELLO", time: "04:00", pickupNote: note("Parcheggio Stadio") },
      { city: "UMBERTIDE", time: "04:15", pickupNote: note("Uscita autostrada zona industriale") },
      { city: "PERUGIA", time: "04:30", pickupNote: note("Pian di Massiano, stazione Minimetrò") },
      { city: "PONTE SAN GIOVANNI", time: "04:40", pickupNote: note("Piazzale Mercedes") },
      { city: "SANTA MARIA DEGLI ANGELI", time: "04:50", pickupNote: note("Hotel Antonelli") },
      { city: "FOLIGNO", time: "05:15", pickupNote: note("City Hotel") },
      { city: "SPOLETO", time: "05:45", pickupNote: note("Hotel Arca") },
      { city: "VITERBO", time: "06:00", pickupNote: note("Piazzale Romiti") },
      { city: "AMELIA", time: "06:10", pickupNote: note("Agenzia Tiva Viaggi") },
      { city: "ORTE", time: "07:10", pickupNote: note("Hotel Tevere") }
    ]
  },
  {
    code: "LINEA_8_CENTRO_2",
    name: "Linea 8 Centro 2",
    validFrom: "2026-04-26",
    validTo: "2026-10-11",
    notes: null,
    stops: [
      { city: "ROMA TIBURTINA", time: "07:45", pickupNote: note("Largo Mazzoni, fronte negozio Smea") },
      { city: "ROMA ANAGNINA", time: "08:15", pickupNote: note("Fermata Atac 502, piazzale del Mercatino") },
      { city: "VALMONTONE", time: "08:45", pickupNote: note("Casello") },
      { city: "CASSINO", time: "10:30", pickupNote: note("Casello") },
      { city: "CASERTA", time: "11:10", pickupNote: note("Casello nord") }
    ]
  },
  {
    code: "LINEA_9_TRENTINO",
    name: "Linea 9 Trentino",
    validFrom: "2026-03-22",
    validTo: null,
    notes: null,
    stops: [
      { city: "MERANO", time: "04:25", pickupNote: note("Stazione FS") },
      { city: "BOLZANO", time: "05:00", pickupNote: note("Piazza Matteotti") },
      { city: "SAN MICHELE ALL'ADIGE", time: "05:20", pickupNote: note("Casello autostradale") },
      { city: "TRENTO", time: "05:35", pickupNote: note("Casello autostradale sud") },
      { city: "ROVERETO", time: "06:05", pickupNote: note("Casello autostradale nord") },
      { city: "ALA AVIO", time: "06:20", pickupNote: note("Casello autostradale") },
      { city: "AFFI", time: "06:35", pickupNote: note("Casello autostradale") },
      { city: "VERONA", time: "06:45", pickupNote: note("Stazione Porta Nuova") },
      { city: "MANTOVA", time: "07:30", pickupNote: note("Casello autostradale nord") },
      { city: "CARPI", time: "08:00", pickupNote: note("Casello autostradale") }
    ]
  },
  {
    code: "LINEA_10_TOSCANA",
    name: "Linea 10 Toscana",
    validFrom: "2026-04-26",
    validTo: null,
    notes: null,
    stops: [
      { city: "VIAREGGIO", time: "08:00", pickupNote: note("Casello autostradale") },
      { city: "LIVORNO", time: "08:15", pickupNote: note("Stazione Ferroviaria") },
      { city: "PISA", time: "08:35", pickupNote: note("Casello autostradale") },
      { city: "LUCCA", time: "08:55", pickupNote: note("Hotel Napoleon") },
      { city: "MONTECATINI", time: "09:15", pickupNote: note("Stazione FS") },
      { city: "PISTOIA", time: "09:30", pickupNote: note("Parcheggio di fronte supermercato Breda") },
      { city: "PRATO", time: "09:50", pickupNote: note("Hotel Palace") }
    ]
  },
  {
    code: "LINEA_11_ADRIATICA",
    name: "Linea 11 Adriatica",
    validFrom: "2026-05-24",
    validTo: "2026-10-11",
    notes: null,
    stops: [
      { city: "CESENA", time: "04:45", pickupNote: note("Casello autostradale") },
      { city: "RIMINI", time: "05:10", pickupNote: note("Casello autostradale sud") },
      { city: "CATTOLICA", time: "05:25", pickupNote: note("Casello autostradale") },
      { city: "PESARO", time: "05:40", pickupNote: note("Casello autostradale") },
      { city: "FANO", time: "05:50", pickupNote: note("Casello autostradale") },
      { city: "SENIGALLIA", time: "06:20", pickupNote: note("Casello autostradale, rotatoria centro commerciale") },
      { city: "IESI", time: "06:35", pickupNote: note("Uscita superstrada Iesi Centro") },
      { city: "ANCONA", time: "06:50", pickupNote: note("Casello autostradale nord") },
      { city: "CIVITANOVA MARCHE", time: "07:20", pickupNote: note("Casello autostradale") },
      { city: "SAN BENEDETTO DEL TRONTO", time: "08:10", pickupNote: note("Casello autostradale") },
      { city: "GIULIANOVA", time: "08:30", pickupNote: note("Casello autostradale") },
      { city: "PESCARA VILLA NOVA", time: "09:00", pickupNote: note("Casello autostradale") },
      { city: "SULMONA", time: "09:30", pickupNote: note("Casello autostradale") },
      { city: "AVEZZANO", time: "10:00", pickupNote: note("Casello autostradale") },
      { city: "SORA", time: "11:00", pickupNote: note("Uscita superstrada") },
      { city: "CASSINO", time: "11:30", pickupNote: note("Casello autostradale") }
    ]
  }
];

export function findBusLineByCode(code?: string | null) {
  const normalized = normalizeBusText(code);
  if (!normalized) return null;
  return BUS_LINES_2026.find((line) => normalizeBusText(line.code) === normalized || normalizeBusText(line.name) === normalized) ?? null;
}

export function findBusStopsByCity(city?: string | null) {
  const normalized = normalizeBusText(city);
  if (!normalized) return [];

  return BUS_LINES_2026.flatMap((line) =>
    line.stops
      .filter((stop) => normalizeBusText(stop.city).includes(normalized) || normalized.includes(normalizeBusText(stop.city)))
      .map((stop) => ({
        lineCode: line.code,
        lineName: line.name,
        stop
      }))
  );
}

export function findNearestBusStop(city?: string | null, time?: string | null) {
  const matches = findBusStopsByCity(city);
  if (matches.length === 0) return null;
  if (!time) return matches[0] ?? null;

  const targetMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return (
    matches
      .map((entry) => {
        const stopMinutes = Number(entry.stop.time.slice(0, 2)) * 60 + Number(entry.stop.time.slice(3, 5));
        return { ...entry, delta: Math.abs(stopMinutes - targetMinutes) };
      })
      .sort((a, b) => a.delta - b.delta)[0] ?? null
  );
}

const busLinesCatalog = {
  BUS_LINES_2026,
  findBusLineByCode,
  findBusStopsByCity,
  findNearestBusStop
};

export default busLinesCatalog;
