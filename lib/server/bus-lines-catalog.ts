export type BusLineStop = {
  city: string;
  time: string;
  pickupNote: string | null;
  lat?: number;
  lng?: number;
};

export type BusLineCatalogEntry = {
  code: string;
  name: string;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
  stops: BusLineStop[];
};

type ManualImportStopOverride = {
  city: string;
  time: string;
  lineCode: string;
  lineName: string;
  pickupNote: string | null;
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

const BUS_CITY_ALIASES: Record<string, string[]> = {
  "s maria degli angeli": ["santa maria degli angeli"],
  "s benedetto del tronto": ["san benedetto del tronto"],
  "citta di castello": ["citta di castello"],
  "citta castello": ["citta di castello"],
  iesi: ["jesi"],
  "chiusi chiaciano": ["chiusi chianciano"],
  schio: ["vicenza"],
  bovezzo: ["brescia"],
  "via carlo alberto della chiesa": ["brescia"],
  // nuvolento: rimosso alias brescia — fermata da definire separatamente
  // cologno monzese: da aggiungere quando confermata la fermata corretta
  "alba adriatica": ["san benedetto del tronto"]
};

const MANUAL_IMPORT_STOP_OVERRIDES: ManualImportStopOverride[] = [
  {
    city: "TERNI",
    time: "05:55",
    lineCode: "LINEA_7_CENTRO",
    lineName: "Linea 7 Centro",
    pickupNote: note("Import Excel cliente - fermata manuale da confermare")
  },
  {
    city: "PONZANO",
    time: "07:20",
    lineCode: "LINEA_8_CENTRO_2",
    lineName: "Linea 8 Centro 2",
    pickupNote: note("Import Excel cliente - fermata manuale da confermare")
  },
  {
    city: "GUIDONIA",
    time: "08:00",
    lineCode: "LINEA_8_CENTRO_2",
    lineName: "Linea 8 Centro 2",
    pickupNote: note("Import Excel cliente - fermata manuale da confermare")
  },
  {
    city: "COLLEFERRO",
    time: "09:15",
    lineCode: "LINEA_8_CENTRO_2",
    lineName: "Linea 8 Centro 2",
    pickupNote: note("Import Excel cliente - fermata manuale da confermare")
  },
  {
    city: "RAVENNA",
    time: "04:20",
    lineCode: "LINEA_11_ADRIATICA",
    lineName: "Linea 11 Adriatica",
    pickupNote: note("Import Excel cliente - fermata manuale da confermare")
  },
  {
    city: "FORLI",
    time: "04:30",
    lineCode: "LINEA_11_ADRIATICA",
    lineName: "Linea 11 Adriatica",
    pickupNote: note("Import Excel cliente - fermata manuale prima di Cesena")
  },
  {
    city: "SAN PAOLO CIVITATE",
    time: "15:40",
    lineCode: "LINEA_PUGLIA_ITALIA",
    lineName: "Bus dedicato Puglia",
    pickupNote: note("Import Excel cliente - gruppo Puglia dedicato")
  },
  {
    city: "GIOVINAZZO",
    time: "16:05",
    lineCode: "LINEA_PUGLIA_ITALIA",
    lineName: "Bus dedicato Puglia",
    pickupNote: note("Import Excel cliente - gruppo Puglia dedicato")
  },
  {
    city: "BARI",
    time: "16:20",
    lineCode: "LINEA_PUGLIA_ITALIA",
    lineName: "Bus dedicato Puglia",
    pickupNote: note("Import Excel cliente - gruppo Puglia dedicato")
  }
];

function deriveFamilyFromLineCode(code: string): { familyCode: "ITALIA" | "CENTRO" | "ADRIATICA"; familyName: string } {
  const normalized = code.toLowerCase();
  const match = normalized.match(/linea[_\s-]*(\d{1,2})/);
  const lineNumber = match ? Number(match[1]) : null;
  if (lineNumber === 7) return { familyCode: "CENTRO", familyName: "Linea Centro" };
  if (lineNumber === 11 || normalized.includes("adriatica")) return { familyCode: "ADRIATICA", familyName: "Linea Adriatica" };
  return { familyCode: "ITALIA", familyName: "Linea Italia" };
}

function busSearchCandidates(city?: string | null) {
  const normalized = normalizeBusText(city);
  if (!normalized) return [];
  return [normalized, ...(BUS_CITY_ALIASES[normalized] ?? [])];
}

export const BUS_LINES_2026: BusLineCatalogEntry[] = [
  {
    code: "LINEA_1_ITALIA",
    name: "Linea 1 Italia",
    validFrom: "2026-02-22",
    validTo: null,
    notes: "Per Ischia. Orari da PDF linee bus 2026.",
    stops: [
      { city: "BRESCIA",          time: "05:00", pickupNote: note("Via Borgosatollo, zona Volta, distributore Eni"), lat: 45.54, lng: 10.22 },
      { city: "BERGAMO",          time: "05:45", pickupNote: note("Parcheggio Hotel Dei Mille"),                    lat: 45.70, lng:  9.67 },
      { city: "MILANO",           time: "06:30", pickupNote: note("Cascina Gobba Terminal Metro"),                  lat: 45.47, lng:  9.19 },
      { city: "MELEGNANO",        time: "06:45", pickupNote: note("Casello autostradale"),                          lat: 45.36, lng:  9.32 },
      { city: "LODI",             time: "07:00", pickupNote: note("Parcheggio Benet"),                              lat: 45.31, lng:  9.50 },
      { city: "PIACENZA",         time: "07:30", pickupNote: note("Parcheggio Stabilimento Iveco"),                 lat: 45.05, lng:  9.69 },
      { city: "FIDENZA",          time: "07:50", pickupNote: note("Casello autostradale"),                          lat: 44.87, lng: 10.06 },
      { city: "PARMA",            time: "08:00", pickupNote: note("Parcheggio Scambiatore"),                        lat: 44.80, lng: 10.33 },
      { city: "REGGIO EMILIA",    time: "08:30", pickupNote: note("Casello autostradale"),                          lat: 44.70, lng: 10.63 },
      { city: "MODENA",           time: "08:45", pickupNote: note("Casello autostradale nord"),                     lat: 44.65, lng: 10.93 },
      { city: "BOLOGNA",          time: "09:15", pickupNote: note("Area di servizio Cantagallo"),                   lat: 44.49, lng: 11.34 },
      { city: "FIRENZE",          time: "10:40", pickupNote: note("Hotel The Gate"),                                lat: 43.77, lng: 11.25 },
      { city: "INCISA",           time: "11:00", pickupNote: note("Casello autostradale"),                          lat: 43.64, lng: 11.44 },
      { city: "VALDARNO",         time: "11:15", pickupNote: note("Casello autostradale"),                          lat: 43.57, lng: 11.56 },
      { city: "AREZZO",           time: "11:40", pickupNote: note("Casello autostradale"),                          lat: 43.47, lng: 11.88 },
      { city: "MONTE SAN SAVINO", time: "11:55", pickupNote: note("Casello autostradale"),                          lat: 43.34, lng: 11.73 },
      { city: "VALDICHIANA",      time: "12:10", pickupNote: note("Casello autostradale"),                          lat: 43.22, lng: 11.87 },
      { city: "CHIUSI CHIANCIANO",time: "12:30", pickupNote: note("Casello autostradale"),                          lat: 43.02, lng: 11.95 },
      { city: "FABRO",            time: "12:45", pickupNote: note("Area di servizio"),                              lat: 42.86, lng: 11.98 },
      { city: "ORVIETO",          time: "13:00", pickupNote: note("Ristorante Food Village"),                       lat: 42.72, lng: 12.11 },
      { city: "ORTE",             time: "13:30", pickupNote: note("Hotel Tevere"),                                  lat: 42.45, lng: 12.39 },
      { city: "ROMA",             time: "14:30", pickupNote: note("Area di Servizio Prenestina Ovest"),             lat: 41.89, lng: 12.49 },
      { city: "FROSINONE",        time: "15:00", pickupNote: note("Casello autostradale"),                          lat: 41.64, lng: 13.35 }
    ]
  },
  {
    code: "LINEA_2_PIEMONTE",
    name: "Linea 2 Piemonte",
    validFrom: "2026-03-08",
    validTo: null,
    notes: null,
    stops: [
      { city: "IVREA",             time: "04:15", pickupNote: note("Casello autostradale"),          lat: 45.47, lng:  7.87 },
      { city: "BIELLA",            time: "04:40", pickupNote: note("A.P.T. Via Lamarmora"),          lat: 45.56, lng:  8.05 },
      { city: "CAVAGLIA",          time: "04:55", pickupNote: note("Casello autostradale"),          lat: 45.41, lng:  8.09 },
      { city: "VERCELLI OVEST",    time: "05:00", pickupNote: note("Casello autostradale"),          lat: 45.33, lng:  8.42 },
      { city: "TORINO",            time: "05:15", pickupNote: note("C.so Stati Uniti 17"),           lat: 45.07, lng:  7.69 },
      { city: "VILLANOVA",         time: "05:25", pickupNote: note("Casello autostradale"),          lat: 44.93, lng:  8.05 },
      { city: "NOVARA",            time: "05:40", pickupNote: note("Casello autostradale Punto Blu"),lat: 45.45, lng:  8.62 },
      { city: "ASTI",              time: "05:45", pickupNote: note("Casello autostradale est"),      lat: 44.90, lng:  8.21 },
      { city: "SANTHIA",           time: "05:55", pickupNote: note("Casello autostradale ovest"),    lat: 45.37, lng:  8.17 },
      { city: "ALESSANDRIA",       time: "06:00", pickupNote: note("Casello autostradale ovest"),    lat: 44.91, lng:  8.61 },
      { city: "TORTONA",           time: "06:10", pickupNote: note("Casello autostradale"),          lat: 44.90, lng:  8.87 },
      { city: "VOGHERA",           time: "06:20", pickupNote: note("Casello autostradale"),          lat: 44.99, lng:  9.01 },
      { city: "CASTEGGIO",         time: "06:30", pickupNote: note("Casello autostradale"),          lat: 45.02, lng:  9.13 },
      { city: "CASTEL SAN GIOVANNI",time: "06:45", pickupNote: note("Casello autostradale"),         lat: 45.06, lng:  9.44 }
    ]
  },
  {
    code: "LINEA_3_LIGURIA",
    name: "Linea 3 Liguria",
    validFrom: "2026-04-26",
    validTo: null,
    notes: null,
    stops: [
      { city: "GENOVA",   time: "06:20", pickupNote: note("Casello ovest davanti Novotel"),      lat: 44.41, lng:  8.93 },
      { city: "CHIAVARI", time: "06:40", pickupNote: note("Rotonda uscita autostradale"),        lat: 44.32, lng:  9.32 },
      { city: "LA SPEZIA",time: "07:20", pickupNote: note("Centro Commerciale La Fabbrica"),     lat: 44.10, lng:  9.82 },
      { city: "MASSA",    time: "07:30", pickupNote: note("Uscita autostradale"),                lat: 44.03, lng: 10.14 }
    ]
  },
  {
    code: "LINEA_4_LOMBARDIA",
    name: "Linea 4 Lombardia",
    validFrom: null,
    validTo: null,
    notes: "Partenze come Linea Italia.",
    stops: [
      { city: "VARESE",       time: "05:00", pickupNote: note("Stazione FF.SS."),                        lat: 45.82, lng:  8.83 },
      { city: "GALLARATE",    time: "05:20", pickupNote: note("Casello autostradale"),                    lat: 45.66, lng:  8.79 },
      { city: "BUSTO ARSIZIO",time: "05:30", pickupNote: note("Uscita autostradale, distributore Api"),   lat: 45.61, lng:  8.85 },
      { city: "LEGNANO",      time: "05:40", pickupNote: note("Uscita autostradale"),                     lat: 45.60, lng:  8.91 },
      { city: "LAINATE",      time: "05:50", pickupNote: note("Casello autostradale"),                    lat: 45.57, lng:  9.01 },
      { city: "RHO",          time: "06:05", pickupNote: note("Casello autostradale"),                    lat: 45.53, lng:  9.04 }
    ]
  },
  {
    code: "LINEA_5_LOMBARDIA_2",
    name: "Linea 5 Lombardia 2",
    validFrom: null,
    validTo: null,
    notes: "Partenze come Linea Italia.",
    stops: [
      { city: "LECCO",             time: "04:20", pickupNote: note("Piazza Stazione FS"),               lat: 45.86, lng:  9.40 },
      { city: "ERBA",              time: "04:45", pickupNote: note("Stazione FS"),                      lat: 45.81, lng:  9.22 },
      { city: "COMO",              time: "05:10", pickupNote: note("Piazza Matteotti"),                  lat: 45.81, lng:  9.09 },
      { city: "SEREGNO",           time: "05:30", pickupNote: note("Stazione FS"),                      lat: 45.65, lng:  9.20 },
      { city: "MONZA",             time: "05:50", pickupNote: note("Piazza Castello, pensilina bus"),    lat: 45.58, lng:  9.27 },
      { city: "SESTO SAN GIOVANNI",time: "06:00", pickupNote: note("Torri Ananas"),                     lat: 45.53, lng:  9.24 },
      { city: "CREMONA",           time: "07:00", pickupNote: note("Casello autostradale"),              lat: 45.13, lng: 10.02 }
    ]
  },
  {
    code: "LINEA_6_VENETO",
    name: "Linea 6 Veneto",
    validFrom: "2026-04-26",
    validTo: null,
    notes: null,
    stops: [
      { city: "FELTRE",         time: "03:30", pickupNote: note("Foro Boario"),               lat: 46.02, lng: 11.91 },
      { city: "BELLUNO",        time: "04:00", pickupNote: note("Stazione Ferroviaria"),       lat: 46.14, lng: 12.22 },
      { city: "VITTORIO VENETO",time: "04:35", pickupNote: note("Casello autostradale sud"),   lat: 45.98, lng: 12.30 },
      { city: "CONEGLIANO",     time: "05:00", pickupNote: note("Casello autostradale"),       lat: 45.89, lng: 12.30 },
      { city: "TREVISO",        time: "05:20", pickupNote: note("Casello autostradale sud"),   lat: 45.67, lng: 12.24 },
      { city: "MESTRE",         time: "05:55", pickupNote: note("Rotonda Holiday Inn"),        lat: 45.49, lng: 12.24 },
      { city: "VICENZA",        time: "06:20", pickupNote: note("Casello autostradale est"),   lat: 45.55, lng: 11.55 },
      { city: "ROVIGO",         time: "07:30", pickupNote: note("Casello autostradale sud"),   lat: 45.07, lng: 11.79 },
      { city: "PADOVA",         time: "07:30", pickupNote: note("Hotel Sheraton"),             lat: 45.41, lng: 11.88 },
      { city: "FERRARA",        time: "08:00", pickupNote: note("Casello nord"),               lat: 44.83, lng: 11.62 }
    ]
  },
  {
    code: "LINEA_7_CENTRO",
    name: "Linea 7 Centro",
    validFrom: "2026-04-26",
    validTo: "2026-10-11",
    notes: "Disponibile anche dal 2025-12-29 al 2026-01-02.",
    stops: [
      { city: "CITTA DI CASTELLO",       time: "04:00", pickupNote: note("Parcheggio Stadio"),                     lat: 43.46, lng: 12.24 },
      { city: "UMBERTIDE",               time: "04:15", pickupNote: note("Uscita autostrada zona industriale"),     lat: 43.31, lng: 12.33 },
      { city: "PERUGIA",                 time: "04:30", pickupNote: note("Pian di Massiano, stazione Minimetrò"),  lat: 43.11, lng: 12.39 },
      { city: "PONTE SAN GIOVANNI",      time: "04:40", pickupNote: note("Piazzale Mercedes"),                     lat: 43.08, lng: 12.44 },
      { city: "SANTA MARIA DEGLI ANGELI",time: "04:50", pickupNote: note("Hotel Antonelli"),                       lat: 43.06, lng: 12.58 },
      { city: "FOLIGNO",                 time: "05:15", pickupNote: note("City Hotel"),                            lat: 42.96, lng: 12.70 },
      { city: "SPOLETO",                 time: "05:45", pickupNote: note("Hotel Arca"),                            lat: 42.74, lng: 12.74 },
      { city: "TERNI",                   time: "05:52", pickupNote: note("Terminal ATC"),                          lat: 42.56, lng: 12.65 },
      { city: "VITERBO",                 time: "06:00", pickupNote: note("Piazzale Romiti"),                       lat: 42.42, lng: 12.11 },
      { city: "AMELIA",                  time: "06:10", pickupNote: note("Agenzia Tiva Viaggi"),                   lat: 42.55, lng: 12.41 },
      { city: "ORTE",                    time: "07:10", pickupNote: note("Hotel Tevere"),                          lat: 42.45, lng: 12.39 }
    ]
  },
  {
    code: "LINEA_8_CENTRO_2",
    name: "Linea 8 Centro 2",
    validFrom: "2026-04-26",
    validTo: "2026-10-11",
    notes: null,
    stops: [
      { city: "ROMA TIBURTINA", time: "07:45", pickupNote: note("Largo Mazzoni, fronte negozio Smea"),         lat: 41.90, lng: 12.53 },
      { city: "ROMA ANAGNINA",  time: "08:15", pickupNote: note("Fermata Atac 502, piazzale del Mercatino"),   lat: 41.84, lng: 12.59 },
      { city: "VALMONTONE",     time: "08:45", pickupNote: note("Casello"),                                    lat: 41.78, lng: 12.92 },
      { city: "CASSINO",        time: "10:30", pickupNote: note("Casello"),                                    lat: 41.49, lng: 13.83 },
      { city: "CASERTA",        time: "11:10", pickupNote: note("Casello nord"),                               lat: 41.07, lng: 14.33 }
    ]
  },
  {
    code: "LINEA_9_TRENTINO",
    name: "Linea 9 Trentino",
    validFrom: "2026-03-22",
    validTo: null,
    notes: null,
    stops: [
      { city: "MERANO",               time: "04:25", pickupNote: note("Stazione FS"),              lat: 46.67, lng: 11.16 },
      { city: "BOLZANO",              time: "05:00", pickupNote: note("Piazza Matteotti"),          lat: 46.50, lng: 11.35 },
      { city: "SAN MICHELE ALL'ADIGE",time: "05:20", pickupNote: note("Casello autostradale"),     lat: 46.18, lng: 11.13 },
      { city: "TRENTO",               time: "05:35", pickupNote: note("Casello autostradale sud"),  lat: 46.07, lng: 11.12 },
      { city: "ROVERETO",             time: "06:05", pickupNote: note("Casello autostradale nord"), lat: 45.89, lng: 11.04 },
      { city: "ALA AVIO",             time: "06:20", pickupNote: note("Casello autostradale"),      lat: 45.76, lng: 11.00 },
      { city: "AFFI",                 time: "06:35", pickupNote: note("Casello autostradale"),      lat: 45.56, lng: 10.78 },
      { city: "VERONA",               time: "06:45", pickupNote: note("Stazione Porta Nuova"),      lat: 45.44, lng: 10.99 },
      { city: "MANTOVA",              time: "07:30", pickupNote: note("Casello autostradale nord"), lat: 45.16, lng: 10.79 },
      { city: "CARPI",                time: "08:00", pickupNote: note("Casello autostradale"),      lat: 44.78, lng: 10.88 }
    ]
  },
  {
    code: "LINEA_10_TOSCANA",
    name: "Linea 10 Toscana",
    validFrom: "2026-04-26",
    validTo: null,
    notes: null,
    stops: [
      { city: "VIAREGGIO",   time: "08:00", pickupNote: note("Casello autostradale"),                        lat: 43.87, lng: 10.25 },
      { city: "LIVORNO",     time: "08:15", pickupNote: note("Stazione Ferroviaria"),                        lat: 43.55, lng: 10.31 },
      { city: "PISA",        time: "08:35", pickupNote: note("Casello autostradale"),                        lat: 43.72, lng: 10.40 },
      { city: "LUCCA",       time: "08:55", pickupNote: note("Hotel Napoleon"),                              lat: 43.84, lng: 10.50 },
      { city: "MONTECATINI", time: "09:15", pickupNote: note("Stazione FS"),                                 lat: 43.88, lng: 10.77 },
      { city: "PISTOIA",     time: "09:30", pickupNote: note("Parcheggio di fronte supermercato Breda"),     lat: 43.93, lng: 10.92 },
      { city: "PRATO",       time: "09:50", pickupNote: note("Hotel Palace"),                                lat: 43.88, lng: 11.10 }
    ]
  },
  {
    code: "LINEA_11_ADRIATICA",
    name: "Linea 11 Adriatica",
    validFrom: "2026-05-24",
    validTo: "2026-10-11",
    notes: null,
    stops: [
      { city: "CESENA",                  time: "04:45", pickupNote: note("Casello autostradale"),                              lat: 44.14, lng: 12.24 },
      { city: "RIMINI",                  time: "05:10", pickupNote: note("Casello autostradale sud"),                          lat: 44.06, lng: 12.57 },
      { city: "CATTOLICA",               time: "05:25", pickupNote: note("Casello autostradale"),                              lat: 43.96, lng: 12.74 },
      { city: "PESARO",                  time: "05:40", pickupNote: note("Casello autostradale"),                              lat: 43.91, lng: 12.91 },
      { city: "FANO",                    time: "05:50", pickupNote: note("Casello autostradale"),                              lat: 43.84, lng: 13.02 },
      { city: "SENIGALLIA",              time: "06:20", pickupNote: note("Casello autostradale, rotatoria centro commerciale"),lat: 43.72, lng: 13.22 },
      { city: "IESI",                    time: "06:35", pickupNote: note("Uscita superstrada Iesi Centro"),                    lat: 43.52, lng: 13.24 },
      { city: "ANCONA",                  time: "06:50", pickupNote: note("Casello autostradale nord"),                         lat: 43.62, lng: 13.51 },
      { city: "CIVITANOVA MARCHE",       time: "07:20", pickupNote: note("Casello autostradale"),                              lat: 43.30, lng: 13.73 },
      { city: "SAN BENEDETTO DEL TRONTO",time: "08:10", pickupNote: note("Casello autostradale"),                              lat: 42.95, lng: 13.88 },
      { city: "GIULIANOVA",              time: "08:30", pickupNote: note("Casello autostradale"),                              lat: 42.75, lng: 13.97 },
      { city: "PESCARA VILLA NOVA",      time: "09:00", pickupNote: note("Casello autostradale"),                              lat: 42.46, lng: 14.21 },
      { city: "SULMONA",                 time: "09:30", pickupNote: note("Casello autostradale"),                              lat: 42.05, lng: 13.92 },
      { city: "AVEZZANO",                time: "10:00", pickupNote: note("Casello autostradale"),                              lat: 41.99, lng: 13.43 },
      { city: "SORA",                    time: "11:00", pickupNote: note("Uscita superstrada"),                                lat: 41.72, lng: 13.61 },
      { city: "CASSINO",                 time: "11:30", pickupNote: note("Casello autostradale"),                              lat: 41.49, lng: 13.83 }
    ]
  }
];

export function findBusLineByCode(code?: string | null) {
  const normalized = normalizeBusText(code);
  if (!normalized) return null;
  return BUS_LINES_2026.find((line) => normalizeBusText(line.code) === normalized || normalizeBusText(line.name) === normalized) ?? null;
}

export function findBusStopsByCity(city?: string | null) {
  const candidates = busSearchCandidates(city);
  if (candidates.length === 0) return [];

  const catalogMatches = BUS_LINES_2026.flatMap((line) =>
    line.stops
      .filter((stop) => {
        const normalizedStop = normalizeBusText(stop.city);
        return candidates.some((candidate) => normalizedStop.includes(candidate) || candidate.includes(normalizedStop));
      })
      .map((stop) => ({
        lineCode: line.code,
        lineName: line.name,
        stop
      }))
  );

  const overrideMatches = MANUAL_IMPORT_STOP_OVERRIDES.filter((override) =>
    candidates.some((candidate) => {
      const normalizedStop = normalizeBusText(override.city);
      return normalizedStop.includes(candidate) || candidate.includes(normalizedStop);
    })
  ).map((override) => ({
    lineCode: override.lineCode,
    lineName: override.lineName,
    stop: {
      city: override.city,
      time: override.time,
      pickupNote: override.pickupNote
    }
  }));

  const all = [...catalogMatches, ...overrideMatches];
  if (all.length <= 1) return all;

  // Preferisce match esatto, poi il più specifico (città più lunga).
  // Evita che "ROMA" vinca su "ROMA TIBURTINA" quando si cerca "ROMA TIBURTINA".
  const primaryCandidate = candidates[0] ?? "";
  const exact = all.filter((m) => normalizeBusText(m.stop.city) === primaryCandidate);
  if (exact.length > 0) return exact;
  return all.sort((a, b) => normalizeBusText(b.stop.city).length - normalizeBusText(a.stop.city).length);
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

/**
 * Ricerca bidirezionale: dato un testo libero (città o indirizzo fermata),
 * cerca prima per nome città poi nel contenuto delle pickupNote.
 * Restituisce il match con il nome canonico della città e la family del gruppo bus.
 */
export function resolveBusStop(raw?: string | null): {
  canonicalCity: string;
  lineCode: string;
  lineName: string;
  pickupNote: string | null;
  time: string;
  familyCode: "ITALIA" | "CENTRO" | "ADRIATICA";
  familyName: string;
} | null {
  if (!raw) return null;

  // 1. Cerca per città (logica esistente)
  const byCity = findBusStopsByCity(raw);
  if (byCity.length > 0) {
    const best = byCity[0]!;
    const family = deriveFamilyFromLineCode(best.lineCode);
    return {
      canonicalCity: best.stop.city,
      lineCode: best.lineCode,
      lineName: best.lineName,
      pickupNote: best.stop.pickupNote,
      time: best.stop.time,
      ...family
    };
  }

  // 2. Fallback: cerca nel testo delle pickupNote
  const needle = normalizeBusText(raw);
  if (!needle) return null;

  // Parole chiave significative (>=4 lettere) per matching fuzzy
  const needleWords = needle.split(" ").filter((w) => w.length >= 4);

  function matchesNote(noteNorm: string): boolean {
    if (!noteNorm) return false;
    if (noteNorm.includes(needle) || needle.includes(noteNorm)) return true;
    // fuzzy: almeno 2 parole chiave in comune
    if (needleWords.length >= 2) {
      const matches = needleWords.filter((w) => noteNorm.includes(w));
      return matches.length >= Math.min(2, needleWords.length);
    }
    return false;
  }

  for (const line of BUS_LINES_2026) {
    for (const stop of line.stops) {
      const noteNorm = normalizeBusText(stop.pickupNote);
      if (matchesNote(noteNorm)) {
        const family = deriveFamilyFromLineCode(line.code);
        return {
          canonicalCity: stop.city,
          lineCode: line.code,
          lineName: line.name,
          pickupNote: stop.pickupNote,
          time: stop.time,
          ...family
        };
      }
    }
  }

  // 3. Cerca anche negli override manuali
  for (const override of MANUAL_IMPORT_STOP_OVERRIDES) {
    const noteNorm = normalizeBusText(override.pickupNote);
    if (matchesNote(noteNorm)) {
      const family = deriveFamilyFromLineCode(override.lineCode);
      return {
        canonicalCity: override.city,
        lineCode: override.lineCode,
        lineName: override.lineName,
        pickupNote: override.pickupNote,
        time: override.time,
        ...family
      };
    }
  }

  return null;
}

const busLinesCatalog = {
  BUS_LINES_2026,
  findBusLineByCode,
  findBusStopsByCity,
  findNearestBusStop
};

export default busLinesCatalog;
