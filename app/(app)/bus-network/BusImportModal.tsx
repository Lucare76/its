"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";

// Mappa orari catalogo 2026 per città canonica (usata come fallback nell'import Excel)
const CATALOG_CITY_TIME: Record<string, string> = {
  "BRESCIA": "05:00", "BERGAMO": "05:45", "MILANO": "06:30", "MELEGNANO": "06:45",
  "LODI": "07:00", "PIACENZA": "07:30", "FIDENZA": "07:50", "PARMA": "08:00",
  "REGGIO EMILIA": "08:30", "MODENA": "08:45", "BOLOGNA": "09:15", "FIRENZE": "10:40",
  "INCISA": "11:00", "VALDARNO": "11:15", "AREZZO": "11:40", "MONTE SAN SAVINO": "11:55",
  "VALDICHIANA": "12:10", "CHIUSI CHIANCIANO": "12:30", "FABRO": "12:45",
  "ORVIETO": "13:00", "ORTE": "13:30", "ROMA": "14:30",
  "IVREA": "04:15", "BIELLA": "04:40", "CAVAGLIA": "04:55", "VERCELLI OVEST": "05:00",
  "TORINO": "05:15", "VILLANOVA": "05:25", "NOVARA": "05:40", "ASTI": "05:45",
  "SANTHIA": "05:55", "ALESSANDRIA": "06:00", "TORTONA": "06:10", "VOGHERA": "06:20",
  "CASTEGGIO": "06:30", "CASTEL SAN GIOVANNI": "06:45",
  "GENOVA": "06:20", "CHIAVARI": "06:40", "LA SPEZIA": "07:20", "MASSA": "07:30",
  "VARESE": "05:00", "GALLARATE": "05:20", "BUSTO ARSIZIO": "05:30", "LEGNANO": "05:40",
  "LAINATE": "05:50", "RHO": "06:05",
  "LECCO": "04:20", "ERBA": "04:45", "COMO": "05:10", "SEREGNO": "05:30",
  "MONZA": "05:50", "SESTO SAN GIOVANNI": "06:00", "CREMONA": "07:00",
  "FELTRE": "03:30", "BELLUNO": "04:00", "VITTORIO VENETO": "04:35",
  "CONEGLIANO": "05:00", "TREVISO": "05:20", "MESTRE": "05:55", "VICENZA": "06:20",
  "ROVIGO": "07:30", "PADOVA": "07:30", "FERRARA": "08:00",
  "CITTA DI CASTELLO": "04:00", "UMBERTIDE": "04:15", "PERUGIA": "04:30",
  "PONTE SAN GIOVANNI": "04:40", "SANTA MARIA DEGLI ANGELI": "05:00",
  "FOLIGNO": "05:15", "SPOLETO": "05:45", "VITERBO": "06:00", "AMELIA": "06:10",
  "ROMA TIBURTINA": "07:45", "ROMA ANAGNINA": "08:15", "VALMONTONE": "08:45",
  "CASSINO": "10:30", "CASERTA": "11:10",
  "MERANO": "04:25", "BOLZANO": "05:00", "SAN MICHELE ALL'ADIGE": "05:20",
  "TRENTO": "05:35", "ROVERETO": "06:05", "ALA AVIO": "06:20", "AFFI": "06:35",
  "VERONA": "06:45", "MANTOVA": "07:30", "CARPI": "08:00",
  "VIAREGGIO": "08:00", "LIVORNO": "08:15", "PISA": "08:35", "LUCCA": "08:55",
  "MONTECATINI": "09:15", "PISTOIA": "09:30", "PRATO": "09:50",
  "CESENA": "04:45", "RIMINI": "05:10", "CATTOLICA": "05:25", "PESARO": "05:40",
  "FANO": "05:50", "SENIGALLIA": "06:20", "IESI": "06:35", "ANCONA": "06:50",
  "CIVITANOVA MARCHE": "07:20", "SAN BENEDETTO DEL TRONTO": "08:10",
  "GIULIANOVA": "08:30", "PESCARA VILLA NOVA": "09:00", "SULMONA": "09:30",
  "AVEZZANO": "10:00", "SORA": "11:00",
};

type BusLine = { id: string; code: string; name: string; family_code: string };
type BusStop = { id: string; bus_line_id: string; direction: "arrival" | "departure"; stop_name: string; city: string; pickup_note?: string | null; pickup_time?: string | null; stop_order: number; lat?: number | null; lng?: number | null; is_manual?: boolean };
type HotelListItem = { id: string; name: string; zone: string };

type ImportRow = {
  name: string;
  phone: string;
  hotel: string;        // colonna A (hotel di partenza)
  agency: string;       // agenzia (billing_party_name)
  cityRaw: string;      // valore originale dal file ("VIA BORGOSATOLLO")
  cityNorm: string;     // città estratta dopo pulizia ("BORGOSATOLLO")
  orario: string;       // orario di prelevamento dal file (se presente)
  pax: number;
  notes: string;
  status: "ok" | "fuzzy" | "pending";
  matchedStop: BusStop | null;
  matchedLine: BusLine | null;
  matchedHotelId: string | null;       // ID hotel nel DB se trovato (match esatto)
  suggestedHotelId: string | null;     // ID hotel suggerito (match fuzzy)
  suggestedHotelName: string | null;   // Nome hotel suggerito
};

// Mappa alias agenzie: il nome raw nel file viene normalizzato al nome ufficiale
const AGENCY_ALIASES: Record<string, string> = {
  "ischia enjoy": "ALESTE VIAGGI",
};

function normalizeAgency(raw: string): string {
  if (!raw.trim()) return "";
  const key = raw.trim().toLowerCase();
  return AGENCY_ALIASES[key] ?? raw.trim();
}

function normalizeHotelName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['".,]/g, " ")
    .replace(/\b(hotel|htl|albergo|residence|locanda|pensione|villa|resort|b&b|bb|terme|spa|club|grand|park|relax|exclusive|boutique|di|del|della|delle|dei|degli|il|la|le|lo|gli|e|d)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tenta di abbinare il nome hotel del file Excel con quelli nel DB
// Ritorna: matchedHotelId (match certo), suggestedHotelId/Name (match fuzzy da confermare)
function matchHotel(
  hotelRaw: string,
  hotels: HotelListItem[]
): { matchedHotelId: string | null; suggestedHotelId: string | null; suggestedHotelName: string | null } {
  if (!hotelRaw.trim() || hotels.length === 0) {
    return { matchedHotelId: null, suggestedHotelId: null, suggestedHotelName: null };
  }
  const norm = normalizeHotelName(hotelRaw);
  if (!norm) return { matchedHotelId: null, suggestedHotelId: null, suggestedHotelName: null };

  // Match esatto (dopo normalizzazione)
  const exact = hotels.find((h) => normalizeHotelName(h.name) === norm);
  if (exact) return { matchedHotelId: exact.id, suggestedHotelId: null, suggestedHotelName: null };

  // Match fuzzy: uno contiene l'altro (minimo 3 caratteri)
  if (norm.length >= 3) {
    const fuzzy = hotels.find((h) => {
      const hn = normalizeHotelName(h.name);
      return hn.length >= 3 && (hn.includes(norm) || norm.includes(hn));
    });
    if (fuzzy) return { matchedHotelId: null, suggestedHotelId: fuzzy.id, suggestedHotelName: fuzzy.name };
  }

  return { matchedHotelId: null, suggestedHotelId: null, suggestedHotelName: null };
}

// Prefissi indirizzo italiani da rimuovere per estrarre il nome del luogo
// Ordinati dal più specifico al più generico
const ADDR_PREFIXES = [
  "casello autostradale ", "casello autost.", "casello aut.", "casello ",
  "stazione ferroviaria ", "stazione fs ", "stzione fs ", "stazione ",
  "parcheggio scambiatore ", "parcheggio ", "area di servizio ", "area servizio ", "autogrill ",
  "via ", "viale ", "piazza ", "corso ", "largo ", "strada ", "contrada ",
  "p.za ", "p.zza ", "v.le ", "rotonda ", "uscita autostradale ", "uscita ",
];

// Token irrilevanti da rimuovere dopo il prefisso
const NOISE_TOKENS = ["fs ", "ff.ss. ", "fs/", "ff.ss./"];

function normCity(v?: string | null) {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Alias per stringhe ambigue che dopo lo stripping non producono un nome città riconoscibile
// (es. "STAZIONE FS" da sola → dopo strip risulta "FS" che è troppo corto per il match)
const CITY_ALIASES: Record<string, string> = {
  "stazione fs": "foligno",
  "stazione f s": "foligno",
  "stazione f.s.": "foligno",
  // Aree di servizio autostradali → città di riferimento
  "prenestina ovest": "roma",
  "prenestina est": "roma",
  "prenestina": "roma",
  "tiburtina": "roma tiburtina",
  "roma tiburtina": "roma tiburtina",
  "anagnina": "roma anagnina",
  "roma anagnina": "roma anagnina",
  "valmontone": "valmontone",
};

function extractCity(raw: string): string {
  // Controlla alias noti prima di qualsiasi stripping
  const rawNorm = normCity(raw);
  if (CITY_ALIASES[rawNorm]) return CITY_ALIASES[rawNorm];

  // "BERGAMO - HOTEL DEI MILLE" → "BERGAMO"
  let city = raw.includes(" - ") ? raw.split(" - ")[0].trim() : raw.trim();

  // Strip prefissi in loop (es. "CASELLO AUTOSTRADALE NORD" → "NORD", ma noi vogliamo tutta la parte restante)
  const lower = () => city.toLowerCase();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of ADDR_PREFIXES) {
      if (lower().startsWith(prefix)) {
        city = city.slice(prefix.length).trim();
        stripped = true;
        break;
      }
    }
  }

  // Strip token irrilevanti iniziali (FS, FF.SS.)
  for (const tok of NOISE_TOKENS) {
    if (lower().startsWith(tok)) {
      city = city.slice(tok.length).trim();
      break;
    }
  }

  // Non troncare alla prima parola — mantieni il nome completo del luogo
  // (es. "PORTA FIORENTINA", "HOTEL DEI MILLE", "STABILIMENTO IVECO")
  return city;
}


function matchAcrossLines(
  city: string,
  stops: BusStop[],
  lines: BusLine[],
  direction: "arrival" | "departure"
): { stop: BusStop | null; line: BusLine | null; status: "ok" | "fuzzy" | "pending" } {
  const nc = normCity(city);
  const expanded = normCity(city.replace(/\bp\.\s*/gi, "ponte ").replace(/\bs\.\s*/gi, "santa ").replace(/\bc\.\s*/gi, "citta "));
  if (!nc || nc.length < 3) return { stop: null, line: null, status: "pending" };

  const dirStops = stops.filter((s) => s.direction === direction);
  const findLine = (s: BusStop) => lines.find((l) => l.id === s.bus_line_id) ?? null;

  const exactMatches = dirStops.filter((s) =>
    normCity(s.city) === nc || normCity(s.stop_name) === nc ||
    normCity(s.city) === expanded || normCity(s.stop_name) === expanded ||
    (s.pickup_note && normCity(s.pickup_note).includes(nc) && nc.length >= 4)
  );

  if (exactMatches.length === 1) return { stop: exactMatches[0], line: findLine(exactMatches[0]), status: "ok" };

  if (exactMatches.length > 1) {
    const catalogFamily = resolveBusStop(city)?.familyCode ?? null;
    if (catalogFamily) {
      const preferred = exactMatches.find((s) => {
        const line = findLine(s);
        return line && line.family_code === catalogFamily;
      });
      if (preferred) return { stop: preferred, line: findLine(preferred), status: "ok" };
    }
    return { stop: exactMatches[0], line: findLine(exactMatches[0]), status: "ok" };
  }

  const fuzzyMatches = dirStops.filter((s) => {
    const sc = normCity(s.city); const sn = normCity(s.stop_name);
    return (sc.length >= 3 && (sc.includes(nc) || nc.includes(sc))) ||
           (sn.length >= 3 && (sn.includes(nc) || nc.includes(sn)));
  });
  if (fuzzyMatches.length > 0) {
    const catalogFamily = resolveBusStop(city)?.familyCode ?? null;
    if (catalogFamily && fuzzyMatches.length > 1) {
      const preferred = fuzzyMatches.find((s) => findLine(s)?.family_code === catalogFamily);
      if (preferred) return { stop: preferred, line: findLine(preferred), status: "fuzzy" };
    }
    return { stop: fuzzyMatches[0], line: findLine(fuzzyMatches[0]), status: "fuzzy" };
  }

  return { stop: null, line: null, status: "pending" };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type CitySuggestion = { displayName: string; shortName: string; lat: number; lng: number };
type NearestInfo = { stop: BusStop; line: BusLine; distKm: number; insertAfterOrder: number };

function findNearestStop(
  lat: number,
  lng: number,
  stopsByLine: { line: BusLine; stops: BusStop[] }[]
): NearestInfo | null {
  let nearest: NearestInfo | null = null;
  let minDist = Infinity;
  for (const { line, stops } of stopsByLine) {
    for (const stop of stops) {
      if (stop.lat == null || stop.lng == null) continue;
      const d = haversineKm(lat, lng, stop.lat, stop.lng);
      if (d < minDist) {
        minDist = d;
        // Nuova fermata va inserita dopo quella più vicina
        const maxOrder = Math.max(...stops.map((s) => s.stop_order));
        nearest = { stop, line, distKm: d, insertAfterOrder: maxOrder + 1 };
      }
    }
  }
  return nearest;
}

function HotelSearchSelect({
  rowIdx,
  initialName,
  matchedHotelId,
  localHotels,
  onMatch,
  onCreate,
}: {
  rowIdx: number;
  initialName: string;
  matchedHotelId: string | null;
  localHotels: HotelListItem[];
  onMatch: (hotelId: string) => void;
  onCreate: (rowIdx: number, form: { name: string; address: string; city: string }) => Promise<void>;
}) {
  const [search, setSearch] = useState(initialName);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; address: string; city: string } | null>(null);
  const [creating, setCreating] = useState(false);

  // Se già abbinato mostra solo il nome con spunta
  if (matchedHotelId) {
    const hotel = localHotels.find((h) => h.id === matchedHotelId);
    return (
      <div className="flex items-center gap-1">
        <span className="text-emerald-600 shrink-0">✓</span>
        <span className="text-xs text-slate-700 uppercase">{hotel?.name ?? "Hotel"}</span>
        <button type="button" onClick={() => onMatch("")}
          className="ml-auto text-[10px] text-slate-300 hover:text-slate-500">✎</button>
      </div>
    );
  }

  const q = search.toLowerCase().trim();
  const filtered = q.length >= 2
    ? localHotels.filter((h) => h.name.toLowerCase().includes(q))
    : [];

  return (
    <div className="relative">
      {!form ? (
        <>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
            placeholder="Cerca hotel..."
            className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-300"
          />
          {open && q.length >= 2 && (
            <div className="absolute left-0 top-full z-50 mt-0.5 w-64 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
              {filtered.map((h) => (
                <button key={h.id} type="button"
                  onMouseDown={() => { onMatch(h.id); setOpen(false); }}
                  className="w-full px-3 py-1.5 text-left hover:bg-violet-50 border-b border-slate-50 last:border-0">
                  <div className="text-xs font-medium text-slate-800">{h.name}</div>
                  <div className="text-[10px] text-slate-400">{h.zone}</div>
                </button>
              ))}
              <button type="button"
                onMouseDown={() => { setForm({ name: search.trim(), address: "", city: "" }); setOpen(false); }}
                className="w-full px-3 py-2 text-left border-t border-slate-100 hover:bg-violet-50">
                <span className="text-[10px] font-semibold text-violet-600">
                  + Aggiungi &quot;{search.trim()}&quot; come nuovo hotel
                </span>
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-1">
          <input value={form.name}
            onChange={(e) => setForm((f) => f && { ...f, name: e.target.value })}
            placeholder="Nome hotel *"
            className="w-full rounded border border-slate-200 px-1.5 py-1 text-[10px]" />
          <input value={form.address}
            onChange={(e) => setForm((f) => f && { ...f, address: e.target.value })}
            placeholder="Indirizzo *"
            className="w-full rounded border border-slate-200 px-1.5 py-1 text-[10px]" />
          <input value={form.city}
            onChange={(e) => setForm((f) => f && { ...f, city: e.target.value })}
            placeholder="Città *"
            className="w-full rounded border border-slate-200 px-1.5 py-1 text-[10px]" />
          <div className="flex gap-1">
            <button type="button" onClick={() => setForm(null)}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-50">←</button>
            <button type="button"
              disabled={creating || !form.name.trim() || !form.address.trim() || !form.city.trim()}
              onClick={async () => {
                setCreating(true);
                await onCreate(rowIdx, form);
                setCreating(false);
                setForm(null);
              }}
              className="flex-1 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-700 disabled:opacity-40">
              {creating ? "..." : "Crea hotel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type CreateStopParams = {
  cityName: string;
  pickupNote: string | null;
  lat: number;
  lng: number;
  lineId: string;
  stopOrder: number;
  orario?: string;
  hotelId?: string | null;
};

type PendingCreate = {
  city: CitySuggestion;
  nearest: NearestInfo;
  pickupNote: string;
  orario: string;
  hotelId: string | null;
  hotelName: string;
  hotelNewForm: { name: string; address: string; city: string } | null;
};

function StopSearchSelect({
  rowIdx,
  search,
  onSearchChange,
  stopsByLine,
  onSelect,
  onCreateStop,
  localHotels,
  onCreateHotel,
}: {
  rowIdx: number;
  search: string;
  onSearchChange: (v: string) => void;
  stopsByLine: { line: BusLine; stops: BusStop[] }[];
  onSelect: (stopId: string) => void;
  onCreateStop: (rowIdx: number, params: CreateStopParams) => Promise<void>;
  localHotels: HotelListItem[];
  onCreateHotel: (form: { name: string; address: string; city: string }) => Promise<HotelListItem | null>;
}) {
  const [open, setOpen] = useState(false);
  const [citySuggestions, setCitySuggestions] = useState<CitySuggestion[]>([]);
  const [cityLoading, setCityLoading] = useState(false);
  // Dopo che l'operatore ha scelto la città, il sistema calcola la linea/posizione
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Autocomplete strade nel campo Fermata
  const [streetSuggestions, setStreetSuggestions] = useState<{ label: string; detail: string }[]>([]);
  const [streetOpen, setStreetOpen] = useState(false);
  const streetDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hotel search nel pannello
  const [hotelSearch, setHotelSearch] = useState("");
  const [hotelDropOpen, setHotelDropOpen] = useState(false);

  const q = search.toLowerCase().trim();

  // Cerca fermata esatta nel catalogo — solo per righe in modalità editing (già matchate)
  const catalogMatches = stopsByLine
    .map(({ line, stops }) => ({
      line,
      stops: stops.filter((s) =>
        !q ||
        s.stop_name.toLowerCase().includes(q) ||
        s.city.toLowerCase().includes(q) ||
        (s.pickup_note ?? "").toLowerCase().includes(q)
      ),
    }))
    .filter((x) => x.stops.length > 0);

  // Auto-seleziona solo se la query corrisponde ESATTAMENTE al nome città o fermata
  const allCatalogStops = catalogMatches.flatMap((x) => x.stops);
  const exactMatch = allCatalogStops.find(
    (s) => s.city.toLowerCase() === q || s.stop_name.toLowerCase() === q
  ) ?? null;

  // Effetto: auto-selezione solo su match esatto
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    if (exactMatch && q.length >= 3) {
      onSelectRef.current(exactMatch.id);
    }
  }, [exactMatch, q]);

  function handleChange(v: string) {
    onSearchChange(v);
    setPendingCreate(null);
    setCitySuggestions([]);
    setOpen(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = v.trim();
    if (trimmed.length < 2) { setCityLoading(false); return; }

    // Cerca sempre su GeoNames/Photon, indipendentemente dai match nel catalogo
    debounceRef.current = setTimeout(async () => {
      setCityLoading(true);
      try {
        const res = await fetch(`/api/geocode/comuni?q=${encodeURIComponent(trimmed)}`);
        const data = (await res.json()) as { results: CitySuggestion[] };
        setCitySuggestions(data.results ?? []);
      } catch {
        setCitySuggestions([]);
      } finally {
        setCityLoading(false);
      }
    }, 350);
  }

  // L'operatore ha scelto la città dall'autocomplete:
  // il sistema calcola automaticamente la linea e la posizione
  function handleCitySelect(city: CitySuggestion) {
    const nearest = findNearestStop(city.lat, city.lng, stopsByLine);
    if (!nearest) return;
    onSearchChange(city.shortName);
    setCitySuggestions([]);
    setOpen(false);
    setPendingCreate({ city, nearest, pickupNote: "", orario: "", hotelId: null, hotelName: "", hotelNewForm: null });
  }

  async function handleConfirmCreate() {
    if (!pendingCreate) return;
    setCreating(true);
    // Se c'è un nuovo hotel da creare, crealo prima
    let finalHotelId = pendingCreate.hotelId;
    if (pendingCreate.hotelNewForm && pendingCreate.hotelNewForm.name.trim()) {
      const newHotel = await onCreateHotel(pendingCreate.hotelNewForm);
      if (newHotel) finalHotelId = newHotel.id;
    }
    await onCreateStop(rowIdx, {
      cityName: pendingCreate.city.shortName,
      pickupNote: pendingCreate.pickupNote.trim() || null,
      lat: pendingCreate.city.lat,
      lng: pendingCreate.city.lng,
      lineId: pendingCreate.nearest.line.id,
      stopOrder: pendingCreate.nearest.insertAfterOrder,
      orario: pendingCreate.orario || undefined,
      hotelId: finalHotelId,
    });
    setCreating(false);
    setPendingCreate(null);
    setHotelSearch("");
  }

  const hasCatalogMatches = catalogMatches.length > 0;

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        placeholder="Scrivi città..."
        value={search}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          setOpen(true);
          // Porta l'input in vista così il dropdown non finisce fuori schermo
          setTimeout(() => inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        className="w-full rounded border border-rose-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-1 focus:ring-rose-300"
      />

      {/* Dropdown suggerimenti */}
      {open && q.length >= 2 && !pendingCreate && (
        <div className="absolute left-0 top-full z-50 mt-0.5 max-h-72 w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {/* Fermate nel catalogo */}
          {hasCatalogMatches && !exactMatch && catalogMatches.map(({ line, stops }) => (
            <div key={line.id}>
              <div className="sticky top-0 bg-indigo-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-indigo-500">{line.name}</div>
              {stops.map((s) => (
                <button key={s.id} type="button" onMouseDown={() => onSelect(s.id)}
                  className="w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                  <span className="font-medium">{s.stop_name}</span>
                  {s.pickup_note && <span className="ml-1 text-slate-400 text-[10px]">{s.pickup_note}</span>}
                </button>
              ))}
            </div>
          ))}

          {/* Suggerimenti GeoNames — sempre visibili sotto il catalogo */}
          {cityLoading && (
            <div className="px-3 py-2 text-xs text-slate-400 animate-pulse border-t border-slate-100">Ricerca comuni...</div>
          )}
          {!cityLoading && citySuggestions.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-amber-50 border-t border-amber-100">
                Aggiungi nuova fermata
              </div>
              {citySuggestions.map((city, idx) => (
                <button key={idx} type="button" onMouseDown={() => handleCitySelect(city)}
                  className="w-full px-3 py-2 text-left hover:bg-amber-50 border-b border-slate-50 last:border-0">
                  <div className="text-xs font-medium text-amber-800">{city.shortName}</div>
                  <div className="text-[10px] text-slate-400 truncate">{city.displayName}</div>
                </button>
              ))}
            </>
          )}
          {!cityLoading && citySuggestions.length === 0 && !hasCatalogMatches && (
            <div className="px-3 py-2 text-xs text-slate-400">
              {q.length < 3 ? "Continua a scrivere..." : `Nessun risultato per "${search.trim()}"`}
            </div>
          )}
        </div>
      )}

      {/* Pannello conferma nuova fermata */}
      {pendingCreate && (
        <div className="fixed z-[200] mt-1 w-80 rounded-xl border border-amber-200 bg-white shadow-xl"
          style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}>
          {creating ? (
            <div className="px-4 py-6 text-center text-sm text-amber-700 animate-pulse">Aggiunta fermata in corso...</div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-amber-100 px-4 py-3">
                <span className="text-xs font-bold uppercase tracking-wide text-amber-700">Nuova fermata</span>
                <button type="button" onMouseDown={() => { setPendingCreate(null); setStreetSuggestions([]); onSearchChange(""); }}
                  className="text-slate-400 hover:text-slate-600 text-sm leading-none">✕</button>
              </div>
              <div className="px-4 py-3 space-y-3">
                {/* Città */}
                <div className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Città</span>
                  <span className="text-sm font-bold text-slate-800">{pendingCreate.city.shortName.toUpperCase()}</span>
                </div>
                {/* Fermata con autocomplete strade */}
                <div className="flex items-start gap-3">
                  <label className="w-14 shrink-0 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Fermata</label>
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={pendingCreate.pickupNote}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPendingCreate((prev) => prev && { ...prev, pickupNote: v });
                        setStreetOpen(true);
                        if (streetDebounceRef.current) clearTimeout(streetDebounceRef.current);
                        if (v.trim().length < 2) { setStreetSuggestions([]); return; }
                        streetDebounceRef.current = setTimeout(async () => {
                          const res = await fetch(`/api/geocode/streets?q=${encodeURIComponent(v.trim())}&lat=${pendingCreate.city.lat}&lng=${pendingCreate.city.lng}`);
                          const data = (await res.json()) as { results: { label: string; detail: string }[] };
                          setStreetSuggestions(data.results ?? []);
                        }, 300);
                      }}
                      onFocus={() => setStreetOpen(true)}
                      onBlur={() => setTimeout(() => setStreetOpen(false), 200)}
                      placeholder="es. Parcheggio Bennet, Via Roma..."
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 placeholder-slate-300 focus:border-amber-300 focus:outline-none focus:ring-1 focus:ring-amber-300"
                    />
                    {streetOpen && streetSuggestions.length > 0 && (
                      <div className="absolute left-0 top-full z-10 mt-0.5 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                        {streetSuggestions.map((s, si) => (
                          <button key={si} type="button"
                            onMouseDown={() => {
                              setPendingCreate((prev) => prev && { ...prev, pickupNote: s.label });
                              setStreetSuggestions([]);
                              setStreetOpen(false);
                            }}
                            className="w-full px-3 py-2 text-left hover:bg-amber-50 border-b border-slate-50 last:border-0">
                            <div className="text-xs font-medium text-slate-800">{s.label}</div>
                            {s.detail && <div className="text-[10px] text-slate-400">{s.detail}</div>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {/* Orario */}
                <div className="flex items-center gap-3">
                  <label className="w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Orario</label>
                  <input
                    type="time"
                    value={pendingCreate.orario}
                    onChange={(e) => setPendingCreate((prev) => prev && { ...prev, orario: e.target.value })}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 focus:border-amber-300 focus:outline-none focus:ring-1 focus:ring-amber-300"
                  />
                </div>
                {/* Hotel */}
                <div className="flex items-start gap-3">
                  <label className="w-14 shrink-0 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Hotel</label>
                  <div className="relative flex-1">
                    {pendingCreate.hotelId ? (
                      <div className="flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                        <span className="text-xs font-medium text-emerald-700">{pendingCreate.hotelName}</span>
                        <button type="button" onMouseDown={() => setPendingCreate((p) => p && { ...p, hotelId: null, hotelName: "", hotelNewForm: null })}
                          className="ml-auto text-slate-300 hover:text-slate-500 text-[10px]">✎</button>
                      </div>
                    ) : pendingCreate.hotelNewForm ? (
                      <div className="space-y-1.5">
                        <input value={pendingCreate.hotelNewForm.name}
                          onChange={(e) => setPendingCreate((p) => p && { ...p, hotelNewForm: p.hotelNewForm && { ...p.hotelNewForm, name: e.target.value } })}
                          placeholder="Nome hotel *"
                          className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                        <input value={pendingCreate.hotelNewForm.address}
                          onChange={(e) => setPendingCreate((p) => p && { ...p, hotelNewForm: p.hotelNewForm && { ...p.hotelNewForm, address: e.target.value } })}
                          placeholder="Indirizzo *"
                          className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                        <input value={pendingCreate.hotelNewForm.city}
                          onChange={(e) => setPendingCreate((p) => p && { ...p, hotelNewForm: p.hotelNewForm && { ...p.hotelNewForm, city: e.target.value } })}
                          placeholder="Città *"
                          className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                        <button type="button" onMouseDown={() => setPendingCreate((p) => p && { ...p, hotelNewForm: null })}
                          className="text-[10px] text-slate-400 hover:text-slate-600">← Annulla</button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={hotelSearch}
                          onChange={(e) => { setHotelSearch(e.target.value); setHotelDropOpen(true); }}
                          onFocus={() => setHotelDropOpen(true)}
                          onBlur={() => setTimeout(() => setHotelDropOpen(false), 200)}
                          placeholder="Cerca hotel (opzionale)..."
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 placeholder-slate-300 focus:border-amber-300 focus:outline-none focus:ring-1 focus:ring-amber-300"
                        />
                        {hotelDropOpen && hotelSearch.trim().length >= 2 && (
                          <div className="absolute left-0 top-full z-10 mt-0.5 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg max-h-40 overflow-y-auto">
                            {localHotels.filter((h) => h.name.toLowerCase().includes(hotelSearch.toLowerCase())).map((h) => (
                              <button key={h.id} type="button"
                                onMouseDown={() => { setPendingCreate((p) => p && { ...p, hotelId: h.id, hotelName: h.name }); setHotelSearch(h.name); setHotelDropOpen(false); }}
                                className="w-full px-3 py-1.5 text-left hover:bg-amber-50 border-b border-slate-50 last:border-0">
                                <div className="text-xs font-medium text-slate-800">{h.name}</div>
                              </button>
                            ))}
                            <button type="button"
                              onMouseDown={() => { setPendingCreate((p) => p && { ...p, hotelNewForm: { name: hotelSearch.trim(), address: "", city: pendingCreate.city.shortName } }); setHotelDropOpen(false); }}
                              className="w-full px-3 py-2 text-left border-t border-slate-100 hover:bg-violet-50">
                              <span className="text-[10px] font-semibold text-violet-600">+ Crea &quot;{hotelSearch.trim()}&quot;</span>
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {/* Posizione nella linea */}
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                  <span className="font-semibold text-slate-700">{pendingCreate.nearest.line.name}</span>
                  {" · inserita dopo "}<span className="font-medium text-indigo-600">{pendingCreate.nearest.stop.stop_name}</span>
                  <span className="text-slate-400"> ({pendingCreate.nearest.distKm.toFixed(0)} km)</span>
                </div>
              </div>
              <div className="flex gap-2 border-t border-slate-100 px-4 py-3">
                <button type="button" onMouseDown={() => { setPendingCreate(null); setStreetSuggestions([]); setHotelSearch(""); onSearchChange(""); }}
                  className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 hover:bg-slate-50">
                  Annulla
                </button>
                <button type="button" onMouseDown={() => void handleConfirmCreate()}
                  className="flex-1 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-600">
                  Conferma
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

async function getToken() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) return null;
  const sb = createClient(url, key);
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function BusImportModal({
  allLines,
  allStops,
  hotelsList,
  direction,
  date,
  onClose,
  onImported,
}: {
  allLines: BusLine[];
  allStops: BusStop[];
  hotelsList: HotelListItem[];
  direction: "arrival" | "departure";
  date: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<"upload" | "preview" | "importing" | "done">("upload");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ assigned: number; pending: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Ricerca per il selettore fermata manuale: mappa idx riga → testo ricerca
  const [stopSearch, setStopSearch] = useState<Record<number, string>>({});
  // Righe in modalità modifica manuale (anche se già abbinate)
  const [editingRows, setEditingRows] = useState<Set<number>>(new Set());
  // Hotel in modalità modifica (click-to-edit)
  const [editingHotels, setEditingHotels] = useState<Set<number>>(new Set());
  // Nomi in modalità modifica (click-to-edit)
  const [editingNames, setEditingNames] = useState<Set<number>>(new Set());
  // Pax in modalità modifica (click-to-edit)
  const [editingPax, setEditingPax] = useState<Set<number>>(new Set());
  const [editingPaxValue, setEditingPaxValue] = useState<Record<number, string>>({});
  // Conferma eliminazione import
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Copia locale degli stop (si aggiorna quando si creano nuove fermate)
  const [localStops, setLocalStops] = useState<BusStop[]>(allStops);
  const [localHotels, setLocalHotels] = useState<HotelListItem[]>(hotelsList);

  const handleCreateHotel = useCallback(async (rowIdx: number, form: { name: string; address: string; city: string }) => {
    const token = await getToken();
    if (!token) return;
    const res = await fetch("/api/ops/bus-network", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "create_hotel", name: form.name, address: form.address, city: form.city }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; hotel?: HotelListItem } | null;
    if (!res.ok || !body?.ok || !body.hotel) return;
    const newHotel = body.hotel;
    setLocalHotels((prev) => [...prev, newHotel]);
    setRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, matchedHotelId: newHotel.id } : r));
  }, []);

  // Versione senza rowIdx — usata dal pannello nuova fermata
  const handleCreateHotelForStop = useCallback(async (form: { name: string; address: string; city: string }): Promise<HotelListItem | null> => {
    const token = await getToken();
    if (!token) return null;
    const res = await fetch("/api/ops/bus-network", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "create_hotel", name: form.name, address: form.address, city: form.city }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; hotel?: HotelListItem } | null;
    if (!res.ok || !body?.ok || !body.hotel) return null;
    setLocalHotels((prev) => [...prev, body.hotel!]);
    return body.hotel!;
  }, []);

  // Aggiornamento manuale stop per righe "da validare"
  const assignRowStop = useCallback((idx: number, stopId: string, stopsOverride?: BusStop[]) => {
    const pool = stopsOverride ?? localStops;
    const stop = pool.find((s) => s.id === stopId) ?? null;
    const line = stop ? (allLines.find((l) => l.id === stop.bus_line_id) ?? null) : null;
    setRows((prev) => prev.map((r, i) => i === idx
      ? { ...r, matchedStop: stop, matchedLine: line, status: stop ? "ok" : "pending" }
      : r
    ));
  }, [localStops, allLines]);

  // Crea una nuova fermata via API e assegna la riga
  const handleCreateStop = useCallback(async (rowIdx: number, params: CreateStopParams) => {
    const token = await getToken();
    if (!token) return;
    const res = await fetch("/api/ops/bus-network", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "add_stop",
        bus_line_id: params.lineId,
        direction,
        stop_name: params.cityName.toUpperCase(),
        city: params.cityName,
        pickup_note: params.pickupNote ?? null,
        lat: params.lat,
        lng: params.lng,
        stop_order: params.stopOrder,
      }),
    });
    const body = (await res.json().catch(() => null)) as ({ ok?: boolean; stops?: BusStop[] } & Record<string, unknown>) | null;
    if (!res.ok || !body?.ok || !body.stops) return;
    // Trova la fermata appena creata nell'elenco aggiornato
    const newStop = body.stops.find(
      (s) => s.bus_line_id === params.lineId &&
             s.direction === direction &&
             s.city.toLowerCase() === params.cityName.toLowerCase() &&
             s.is_manual
    );
    if (!newStop) return;
    const updated = [...localStops, newStop];
    setLocalStops(updated);
    assignRowStop(rowIdx, newStop.id, updated);
    // Aggiorna orario e hotel sulla riga se forniti
    if (params.orario || params.hotelId !== undefined) {
      setRows((prev) => prev.map((r, i) => i !== rowIdx ? r : {
        ...r,
        orario: params.orario || r.orario,
        matchedHotelId: params.hotelId ?? r.matchedHotelId,
      }));
    }
  }, [direction, localStops, assignRowStop]);

  const handleFile = useCallback(async (file: File) => {
    setError("");
    try {
      const { read, utils } = await import("xlsx");
      const ab = await file.arrayBuffer();
      const wb = read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false }) as unknown[][];
      if (raw.length < 2) { setError("File vuoto o senza dati."); return; }

      const KNOWN = ["cognome", "nome", "nominativo", "telefono", "cellulare",
        "punto di carico", "destinazione", "hotel", "pax", "note",
        "orario", "città", "citta", "city", "fermata", "agenzia"];

      let headerRowIdx = 0;
      // Usa la PRIMA riga (entro le prime 3) che contiene almeno 2 parole chiave —
      // così non si saltano dati nelle righe precedenti all'intestazione trovata
      for (let ri = 0; ri < Math.min(3, raw.length); ri++) {
        const r = Array.from(raw[ri] as ArrayLike<unknown>, (v) => String(v ?? "").toLowerCase().trim());
        const score = r.filter((h) => KNOWN.some((k) => h.includes(k))).length;
        if (score >= 2) { headerRowIdx = ri; break; }
      }

      const headerRow = Array.from(raw[headerRowIdx] as ArrayLike<unknown>, (v) => String(v ?? "").toLowerCase().trim());
      const col = (patterns: string[]) => {
        for (const p of patterns) {
          const i = headerRow.findIndex((h) => h.includes(p));
          if (i >= 0) return i;
        }
        return -1;
      };

      const nameCol   = col(["nominativo", "cognome", "nome", "passeggero", "cliente", "name", "beneficiario"]);
      const phoneCol  = col(["cellulare", "cell", "telefono", "phone", "tel"]);
      const cityCol   = col(["punto di carico", "destinazione", "carico", "città", "citta", "city", "fermata", "partenza", "localita", "località"]);
      const paxCol    = col(["pax", "passeggeri", "n.", "num", "quantità", "persone"]);
      const hotelCol  = col(["albergo", "hotel partenza", "hotel arrivo", "struttura", "hotel"]);
      const notesCol  = col(["agenzia", "agency", "note", "notes", "annotazioni"]);
      const orarioCol = col(["orario", "ora", "ora partenza", "ora ritiro", "time"]);
      // Colonna J (indice 9) per agenzia speciale — letta sia per intestazione sia per posizione fissa
      const agencyJCol = col(["touroperator", "operatore", "agenzia speciale", "t.o.", "to "]) >= 0
        ? col(["touroperator", "operatore", "agenzia speciale", "t.o.", "to "])
        : (headerRow.length > 9 ? 9 : -1);

      if (nameCol < 0 && cityCol < 0) {
        const found = headerRow.filter(Boolean).join(", ") || "(nessuna intestazione trovata)";
        setError(`Intestazioni non riconosciute. Colonne trovate: ${found}.`);
        return;
      }

      const parsed: ImportRow[] = [];
      for (let i = headerRowIdx + 1; i < raw.length; i++) {
        const rowData = raw[i] as unknown[];
        if (!Array.isArray(rowData) || rowData.every((c) => !String(c ?? "").trim())) continue;
        const r0 = String(rowData[0] ?? "").toLowerCase().trim();
        if (KNOWN.some((k) => r0.includes(k))) continue;

        const str = (idx: number) => (idx >= 0 ? String(rowData[idx] ?? "").trim() : "");
        const hotel = str(hotelCol);
        const cityRaw = str(cityCol);
        const paxRaw = str(paxCol);
        const pax = Math.max(1, parseInt(paxRaw || "1", 10) || 1);

        // Accetta la riga se ha un nome OPPURE se ha fermata + pax validi (gruppi senza nominativo individuale)
        const nameRaw = str(nameCol) || hotel || str(0);
        const hasCity = cityRaw.trim().length > 0;
        const hasPax = /^\d+$/.test(paxRaw) && parseInt(paxRaw, 10) > 0;
        if (!nameRaw && !(hasCity && hasPax)) continue;
        const name = nameRaw || `Gruppo ${pax} pax`;
        const phone = str(phoneCol);
        // Estrai orario e città dall'orario — alcuni file usano "04:30 ESINE" nello stesso campo
        const rawOrarioRaw = str(orarioCol);
        const orarioMatch = rawOrarioRaw.trim().match(/^(\d{1,2}:\d{2})(?::\d{2})?\s*(.*)$/);
        const rawOrario = orarioMatch ? orarioMatch[1] : "";
        const cityFromOrario = orarioMatch?.[2]?.trim() ?? "";
        // Usa la città dalla colonna destinazione; se vuota o solo indirizzo, prova da colonna orario
        const cityNorm = extractCity(cityRaw) || cityFromOrario;
        // Leggi agenzia da colonna notesCol e da colonna J (con alias mapping)
        const agencyRaw = str(notesCol) || str(agencyJCol);
        const agency = normalizeAgency(agencyRaw);
        const notes = "";

        const { stop, line, status } = matchAcrossLines(cityFromOrario || cityNorm, allStops, allLines, direction);
        // Fallback orario: usa la città canonica matchata (es. "BRESCIA" da "BORGOSATOLLO")
        const canonicalCity = (stop?.city ?? cityNorm).toUpperCase().trim();
        const catalogTime = CATALOG_CITY_TIME[canonicalCity] ?? "";
        const orario = rawOrario || stop?.pickup_time || catalogTime;
        const { matchedHotelId, suggestedHotelId, suggestedHotelName } = matchHotel(hotel, hotelsList);
        parsed.push({ name, phone, hotel, agency, cityRaw, cityNorm, orario, pax, notes, status, matchedStop: stop, matchedLine: line, matchedHotelId, suggestedHotelId, suggestedHotelName });
      }

      if (parsed.length === 0) { setError("Nessuna riga valida trovata nel file."); return; }
      setRows(parsed);
      setStep("preview");
    } catch (e) {
      setError("Errore lettura file: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [allStops, allLines, direction, hotelsList]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }, [handleFile]);

  const doImport = useCallback(async () => {
    setStep("importing");
    setError("");
    try {
      const token = await getToken();
      if (!token) { setError("Sessione non valida."); setStep("preview"); return; }
      const payload = rows.map((r) => ({
        name: r.name,
        phone: r.phone || null,
        city: r.cityNorm,
        pax: r.pax,
        notes: r.notes || null,
        hotel: r.hotel || null,
        hotel_id: r.matchedHotelId ?? null,
        agency: r.agency || null,
        pickup_time: r.orario || null,
        // Se l'utente ha assegnato manualmente uno stop, lo passiamo esplicitamente
        stop_id: r.matchedStop?.id ?? null,
        bus_line_id: r.matchedLine?.id ?? null,
      }));
      const res = await fetch("/api/ops/bus-network", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "import_excel_auto",
          direction,
          travel_date: date,
          rows: payload,
        }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; assigned?: number; pending?: number } | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Errore durante l'importazione.");
        setStep("preview");
        return;
      }
      setResult({ assigned: body.assigned ?? 0, pending: body.pending ?? 0 });
      setStep("done");
      onImported();
    } catch (e) {
      setError("Errore di rete: " + (e instanceof Error ? e.message : String(e)));
      setStep("preview");
    }
  }, [rows, direction, date, onImported]);

  const okCount      = rows.filter((r) => r.status === "ok").length;
  const fuzzyCount   = rows.filter((r) => r.status === "fuzzy").length;
  const pendingCount = rows.filter((r) => r.status === "pending").length;
  const totalPax     = rows.reduce((s, r) => s + r.pax, 0);

  const linesSummary = allLines
    .map((l) => ({
      line: l,
      count: rows.filter((r) => r.matchedLine?.id === l.id).length,
      pax: rows.filter((r) => r.matchedLine?.id === l.id).reduce((s, r) => s + r.pax, 0),
    }))
    .filter((x) => x.count > 0);

  // Fermate raggruppate per linea per il select manuale
  const stopsByLine = allLines.map((l) => ({
    line: l,
    stops: localStops.filter((s) => s.bus_line_id === l.id && s.direction === direction).sort((a, b) => a.stop_order - b.stop_order),
  })).filter((x) => x.stops.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl" style={{ maxHeight: "90vh" }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Importa Excel</h2>
            <p className="text-sm text-slate-500">
              {direction === "arrival" ? "Arrivi" : "Partenze"} — {date} — assegnazione automatica per linea
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* STEP: upload */}
          {step === "upload" && (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 py-16 text-center hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
            >
              <span className="text-4xl">📄</span>
              <div>
                <p className="font-medium text-slate-700">Trascina un file .xlsx o clicca per selezionarlo</p>
                <p className="mt-1 text-sm text-slate-400">
                  Il sistema assegnerà automaticamente ogni passeggero alla linea corretta in base alla destinazione
                </p>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
            </div>
          )}

          {/* STEP: preview */}
          {(step === "preview" || step === "importing") && (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  {okCount} fermata esatta
                </span>
                {fuzzyCount > 0 && (
                  <span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700">
                    <span className="h-2 w-2 rounded-full bg-amber-400" />
                    {fuzzyCount} parziale
                  </span>
                )}
                {pendingCount > 0 && (
                  <span className="flex items-center gap-1.5 rounded-full bg-rose-50 px-3 py-1 text-sm font-medium text-rose-700">
                    <span className="h-2 w-2 rounded-full bg-rose-400" />
                    {pendingCount} da assegnare
                  </span>
                )}
                <span className="ml-auto rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600">
                  {rows.length} righe · {totalPax} pax
                </span>
              </div>

              {linesSummary.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {linesSummary.map(({ line, count, pax }) => (
                    <span key={line.id} className="rounded-lg bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700">
                      {line.name}: {count} pass. · {pax} pax
                    </span>
                  ))}
                  {pendingCount > 0 && (
                    <span className="rounded-lg bg-rose-50 px-3 py-1 text-sm font-medium text-rose-600">
                      Da assegnare: {pendingCount}
                    </span>
                  )}
                </div>
              )}

              {pendingCount > 0 && (
                <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-800">
                  Le righe rosse non sono state riconosciute automaticamente. Seleziona la fermata corretta dal menu a discesa oppure lasciale come &quot;da validare&quot; per assegnarle dopo.
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">Passeggero</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">Hotel partenza</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">Destinazione</th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-400">Pax</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">Note</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">Linea → Fermata</th>
                      <th className="w-6 px-1" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row, i) => (
                      <tr key={i} className={
                        row.status === "ok" ? "bg-emerald-50/40" :
                        row.status === "fuzzy" ? "bg-amber-50/40" : "bg-rose-50/40"
                      }>
                        <td className="px-3 py-2">
                          {editingNames.has(i) ? (
                            <input
                              autoFocus
                              value={row.name}
                              onChange={(e) => setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, name: e.target.value } : r))}
                              onBlur={() => setEditingNames((prev) => { const s = new Set(prev); s.delete(i); return s; })}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingNames((prev) => { const s = new Set(prev); s.delete(i); return s; }); }}
                              className="w-full rounded border border-indigo-300 px-1 py-0.5 text-xs font-medium uppercase text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                            />
                          ) : (
                            <div
                              className="cursor-pointer group flex items-start gap-1"
                              onClick={() => setEditingNames((prev) => new Set(prev).add(i))}
                              title="Clicca per modificare nome"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-medium uppercase text-slate-800 group-hover:underline decoration-dotted">{row.name}</div>
                                {row.phone && <div className="text-xs text-slate-400">{row.phone}</div>}
                              </div>
                              <span className="text-[10px] text-slate-300 group-hover:text-slate-400 shrink-0">✎</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 w-36">
                          {editingHotels.has(i) ? (
                            <HotelSearchSelect
                              rowIdx={i}
                              initialName={row.hotel}
                              matchedHotelId={row.matchedHotelId}
                              localHotels={localHotels}
                              onMatch={(hotelId) => {
                                const matched = localHotels.find((h) => h.id === hotelId);
                                setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, matchedHotelId: hotelId || null, hotel: matched?.name ?? r.hotel } : r));
                                setEditingHotels((prev) => { const s = new Set(prev); s.delete(i); return s; });
                              }}
                              onCreate={handleCreateHotel}
                            />
                          ) : row.matchedHotelId ? (
                            <div className="cursor-pointer group flex items-center gap-1"
                              onClick={() => setEditingHotels((prev) => new Set(prev).add(i))}
                              title="Clicca per modificare hotel">
                              <span className="text-xs text-emerald-700 group-hover:underline decoration-dotted">✓ {row.hotel}</span>
                              <span className="text-[10px] text-slate-300 group-hover:text-slate-400 shrink-0">✎</span>
                            </div>
                          ) : row.suggestedHotelId && !row.matchedHotelId ? (
                            <div className="space-y-1">
                              <div className="text-xs text-amber-700">⚠ {row.hotel}</div>
                              <div className="rounded bg-amber-50 border border-amber-200 px-2 py-1">
                                <div className="text-[10px] text-amber-700 mb-1">Forse intendevi <span className="font-semibold">{row.suggestedHotelName}</span>?</div>
                                <div className="flex gap-1">
                                  <button type="button"
                                    onClick={() => setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, matchedHotelId: r.suggestedHotelId, hotel: r.suggestedHotelName ?? r.hotel, suggestedHotelId: null, suggestedHotelName: null } : r))}
                                    className="flex-1 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-600">
                                    ✓ Sì
                                  </button>
                                  <button type="button"
                                    onClick={() => setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, suggestedHotelId: null, suggestedHotelName: null } : r))}
                                    className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50">
                                    ✕
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : row.hotel ? (
                            <div className="cursor-pointer group flex items-center gap-1"
                              onClick={() => setEditingHotels((prev) => new Set(prev).add(i))}
                              title="Hotel non riconosciuto — clicca per abbinare">
                              <span className="text-xs text-amber-600 group-hover:underline decoration-dotted">⚠ {row.hotel}</span>
                              <span className="text-[10px] text-slate-300 group-hover:text-slate-400 shrink-0">✎</span>
                            </div>
                          ) : (
                            <button type="button"
                              onClick={() => setEditingHotels((prev) => new Set(prev).add(i))}
                              className="text-[10px] text-slate-300 hover:text-violet-500 hover:underline">
                              + Aggiungi hotel
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-slate-700 uppercase text-xs">{row.cityNorm || "—"}</div>
                          {row.cityRaw !== row.cityNorm && (
                            <div className="text-xs text-slate-400">{row.cityRaw}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {editingPax.has(i) ? (
                            <input
                              autoFocus
                              type="number"
                              min={1}
                              max={120}
                              value={editingPaxValue[i] ?? String(row.pax)}
                              onChange={(e) => setEditingPaxValue((prev) => ({ ...prev, [i]: e.target.value }))}
                              onBlur={() => {
                                const val = parseInt(editingPaxValue[i] ?? "", 10);
                                if (!isNaN(val) && val >= 1) {
                                  setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, pax: val } : r));
                                }
                                setEditingPax((prev) => { const s = new Set(prev); s.delete(i); return s; });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") setEditingPax((prev) => { const s = new Set(prev); s.delete(i); return s; });
                              }}
                              className="w-12 rounded border border-indigo-300 bg-indigo-50 px-1 py-0.5 text-center text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            />
                          ) : (
                            <span
                              className="cursor-pointer rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-indigo-100 hover:text-indigo-700"
                              title="Clicca per modificare pax"
                              onClick={() => {
                                setEditingPaxValue((prev) => ({ ...prev, [i]: String(row.pax) }));
                                setEditingPax((prev) => new Set(prev).add(i));
                              }}
                            >{row.pax}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 w-36">
                          <textarea
                            value={row.notes}
                            onChange={(e) => setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, notes: e.target.value } : r))}
                            placeholder="es. Posto 12, allergie..."
                            rows={1}
                            className="w-full resize-none rounded border border-transparent px-1.5 py-1 text-xs text-slate-700 placeholder-slate-300 hover:border-slate-200 focus:border-indigo-300 focus:outline-none focus:ring-0"
                          />
                        </td>
                        <td className="px-3 py-2">
                          {(row.status === "ok" || row.status === "fuzzy") && !editingRows.has(i) && (
                            <div className="flex items-start gap-1">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-indigo-600">{row.matchedLine?.name}</div>
                                <div className={`flex items-center gap-1 ${row.status === "ok" ? "text-emerald-700" : "text-amber-700"}`}>
                                  <span className="text-xs">{row.status === "ok" ? "✓" : "~"}</span>
                                  <span className="text-xs">{row.matchedStop?.stop_name}</span>
                                </div>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-[10px] text-slate-400">🕐</span>
                                  <input
                                    type="time"
                                    value={row.orario || row.matchedStop?.pickup_time || ""}
                                    onChange={(e) => setRows((prev) => prev.map((r, ri) => ri === i ? { ...r, orario: e.target.value } : r))}
                                    placeholder="--:--"
                                    className="w-16 rounded border border-transparent px-1 py-0 text-[10px] text-slate-500 hover:border-slate-200 focus:border-indigo-300 focus:outline-none focus:ring-0 bg-transparent"
                                  />
                                </div>
                              </div>
                              <button
                                type="button"
                                title="Modifica fermata"
                                onClick={() => setEditingRows((prev) => { const s = new Set(prev); s.add(i); return s; })}
                                className="shrink-0 rounded p-0.5 text-slate-300 hover:bg-indigo-50 hover:text-indigo-500"
                              >✎</button>
                            </div>
                          )}
                          {(row.status === "pending" || editingRows.has(i)) && (
                            <StopSearchSelect
                              rowIdx={i}
                              search={stopSearch[i] ?? ""}
                              onSearchChange={(v) => setStopSearch((prev) => ({ ...prev, [i]: v }))}
                              stopsByLine={stopsByLine}
                              onSelect={(stopId) => {
                                assignRowStop(i, stopId);
                                setStopSearch((prev) => ({ ...prev, [i]: "" }));
                                setEditingRows((prev) => { const s = new Set(prev); s.delete(i); return s; });
                              }}
                              onCreateStop={handleCreateStop}
                              localHotels={localHotels}
                              onCreateHotel={handleCreateHotelForStop}
                            />
                          )}
                        </td>
                        <td className="w-8 px-1 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => setRows((prev) => prev.filter((_, ri) => ri !== i))}
                            className="rounded p-0.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                            title="Rimuovi riga"
                          >✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* STEP: done */}
          {step === "done" && result && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <span className="text-5xl">✅</span>
              <h3 className="text-lg font-bold text-slate-900">Importazione completata</h3>
              <div className="flex gap-4">
                <div className="rounded-xl bg-emerald-50 px-6 py-4 text-center">
                  <div className="text-2xl font-bold text-emerald-700">{result.assigned}</div>
                  <div className="text-sm text-emerald-600">Assegnati al bus</div>
                </div>
                {result.pending > 0 && (
                  <div className="rounded-xl bg-amber-50 px-6 py-4 text-center">
                    <div className="text-2xl font-bold text-amber-700">{result.pending}</div>
                    <div className="text-sm text-amber-600">Da validare</div>
                  </div>
                )}
              </div>
              {result.pending > 0 && (
                <p className="text-sm text-slate-500">
                  I passeggeri da validare sono visibili nel tab <strong>Da validare</strong>.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-slate-100 px-6 py-4">
          {step === "upload" && (
            <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
              Annulla
            </button>
          )}
          {(step === "preview" || step === "importing") && (
            <>
              <button onClick={() => { setStep("upload"); setRows([]); setError(""); setConfirmDelete(false); }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                ← Indietro
              </button>
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-rose-700 font-medium">Eliminare questo import?</span>
                  <button
                    onClick={() => { setRows([]); setStep("upload"); setError(""); setConfirmDelete(false); }}
                    className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700">
                    Sì, elimina
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                    Annulla
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={step === "importing"}
                  className="rounded-lg border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                  🗑 Elimina import
                </button>
              )}
              <button onClick={() => void doImport()}
                disabled={step === "importing" || rows.length === 0}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {step === "importing"
                  ? "Importazione in corso..."
                  : `Importa ${rows.length} passeggeri${pendingCount > 0 ? ` (${pendingCount} da validare)` : ""}`}
              </button>
            </>
          )}
          {step === "done" && (
            <button onClick={onClose}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700">
              Chiudi
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
