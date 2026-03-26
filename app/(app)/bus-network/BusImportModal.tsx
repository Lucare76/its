"use client";

import { useState, useRef, useCallback } from "react";

type BusLine = { id: string; code: string; name: string };
type BusStop = { id: string; bus_line_id: string; direction: "arrival" | "departure"; stop_name: string; city: string; pickup_note?: string | null; pickup_time?: string | null; stop_order: number };

type ImportRow = {
  name: string;
  phone: string;
  hotel: string;        // colonna A (hotel di partenza)
  cityRaw: string;      // valore originale dal file ("VIA BORGOSATOLLO")
  cityNorm: string;     // città estratta dopo pulizia ("BORGOSATOLLO")
  orario: string;       // orario di prelevamento dal file (se presente)
  pax: number;
  notes: string;
  status: "ok" | "fuzzy" | "pending";
  matchedStop: BusStop | null;
  matchedLine: BusLine | null;
};

// Prefissi indirizzo italiani da rimuovere per estrarre il nome del luogo
// Ordinati dal più specifico al più generico
const ADDR_PREFIXES = [
  "casello autostradale ", "casello autost.", "casello aut.", "casello ",
  "stazione ferroviaria ", "stazione fs ", "stzione fs ", "stazione ",
  "parcheggio scambiatore ", "parcheggio ", "area di servizio ", "autogrill ",
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

// Parole da ignorare nel matching per parola-chiave
// Include parole di infrastruttura trasporti che non identificano univocamente una città
const STOP_WORDS = new Set([
  "di", "del", "della", "delle", "dei", "da", "al", "no", "il", "la", "le", "lo", "e",
  "via", "zona", "area", "nord", "sud", "est", "ovest", "nuovo", "nuova", "san", "santa",
  "fermata", "piazzale", "parcheggio", "casello", "stazione", "terminal", "largo", "uscita",
  "distributore", "autostrada", "autostradale", "superstrada", "rotonda", "svincolo",
  "mercato", "centro", "commerciale", "servizio",
]);

// Restituisce true se almeno una parola significativa (≥4 chars) è condivisa tra a e b
function hasKeywordOverlap(a: string, b: string): boolean {
  const words = (s: string) => s.split(/\s+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  const wa = words(a);
  const wb = words(b);
  return wa.some((x) => wb.some((y) => x === y || x.includes(y) || y.includes(x)));
}

function matchAcrossLines(
  city: string,
  stops: BusStop[],
  lines: BusLine[],
  direction: "arrival" | "departure"
): { stop: BusStop | null; line: BusLine | null; status: "ok" | "fuzzy" | "pending" } {
  const nc = normCity(city);
  if (!nc || nc.length < 3) return { stop: null, line: null, status: "pending" };

  const dirStops = stops.filter((s) => s.direction === direction);
  const findLine = (s: BusStop) => lines.find((l) => l.id === s.bus_line_id) ?? null;

  // Exact: città o stop_name uguali, oppure pickup_note contiene la stringa cercata
  const exact = dirStops.find((s) =>
    normCity(s.city) === nc ||
    normCity(s.stop_name) === nc ||
    (s.pickup_note && normCity(s.pickup_note).includes(nc) && nc.length >= 4)
  );
  if (exact) return { stop: exact, line: findLine(exact), status: "ok" };

  // Fuzzy: substring match su city/stop_name/pickup_note, oppure keyword overlap su pickup_note
  const fuzzy = dirStops.find((s) => {
    const sc = normCity(s.city);
    const sn = normCity(s.stop_name);
    const sp = s.pickup_note ? normCity(s.pickup_note) : "";
    return sc.includes(nc) || nc.includes(sc) ||
      sn.includes(nc) || nc.includes(sn) ||
      (sp && nc.length >= 4 && (sp.includes(nc) || nc.includes(sp) || hasKeywordOverlap(nc, sp)));
  });
  if (fuzzy) return { stop: fuzzy, line: findLine(fuzzy), status: "fuzzy" };

  return { stop: null, line: null, status: "pending" };
}

function StopSearchSelect({
  rowIdx,
  search,
  onSearchChange,
  stopsByLine,
  onSelect,
}: {
  rowIdx: number;
  search: string;
  onSearchChange: (v: string) => void;
  stopsByLine: { line: BusLine; stops: BusStop[] }[];
  onSelect: (stopId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const q = search.toLowerCase().trim();
  const filtered = stopsByLine
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

  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Cerca fermata..."
        value={search}
        onChange={(e) => { onSearchChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded border border-rose-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-1 focus:ring-rose-300"
      />
      {open && (
        <div className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">Nessuna fermata trovata</div>
          ) : (
            filtered.map(({ line, stops }) => (
              <div key={line.id}>
                <div className="sticky top-0 bg-indigo-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-indigo-500">{line.name}</div>
                {stops.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onMouseDown={() => onSelect(s.id)}
                    className="w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                  >
                    <span className="font-medium">{s.stop_name}</span>
                    {s.pickup_note && <span className="ml-1 text-slate-400 text-[10px]">{s.pickup_note}</span>}
                  </button>
                ))}
              </div>
            ))
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
  direction,
  date,
  onClose,
  onImported,
}: {
  allLines: BusLine[];
  allStops: BusStop[];
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

  // Aggiornamento manuale stop per righe "da validare"
  const assignRowStop = useCallback((idx: number, stopId: string) => {
    const stop = allStops.find((s) => s.id === stopId) ?? null;
    const line = stop ? (allLines.find((l) => l.id === stop.bus_line_id) ?? null) : null;
    setRows((prev) => prev.map((r, i) => i === idx
      ? { ...r, matchedStop: stop, matchedLine: line, status: stop ? "ok" : "pending" }
      : r
    ));
  }, [allStops, allLines]);

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
      let bestScore = 0;
      for (let ri = 0; ri < Math.min(4, raw.length); ri++) {
        const r = Array.from(raw[ri] as ArrayLike<unknown>, (v) => String(v ?? "").toLowerCase().trim());
        const score = r.filter((h) => KNOWN.some((k) => h.includes(k))).length;
        if (score > bestScore) { bestScore = score; headerRowIdx = ri; }
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
        const name = str(nameCol) || hotel || str(0);
        if (!name) continue;

        const cityRaw = str(cityCol);
        const cityNorm = extractCity(cityRaw);
        const pax = Math.max(1, parseInt(str(paxCol) || "1", 10) || 1);
        const phone = str(phoneCol);
        const orario = str(orarioCol);
        const agency = str(notesCol);
        const notes = [hotel && `Hotel: ${hotel}`, agency && `Agenzia: ${agency}`].filter(Boolean).join(" · ");

        const { stop, line, status } = matchAcrossLines(cityNorm, allStops, allLines, direction);
        parsed.push({ name, phone, hotel, cityRaw, cityNorm, orario, pax, notes, status, matchedStop: stop, matchedLine: line });
      }

      if (parsed.length === 0) { setError("Nessuna riga valida trovata nel file."); return; }
      setRows(parsed);
      setStep("preview");
    } catch (e) {
      setError("Errore lettura file: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [allStops, allLines, direction]);

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
    stops: allStops.filter((s) => s.bus_line_id === l.id && s.direction === direction).sort((a, b) => a.stop_order - b.stop_order),
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
                          <div className="font-medium uppercase text-slate-800">{row.name}</div>
                          {row.phone && <div className="text-xs text-slate-400">{row.phone}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600 uppercase">
                          {row.hotel || <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-slate-700 uppercase text-xs">{row.cityNorm || "—"}</div>
                          {row.cityRaw !== row.cityNorm && (
                            <div className="text-xs text-slate-400">{row.cityRaw}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{row.pax}</span>
                        </td>
                        <td className="px-3 py-2">
                          {row.status === "ok" && (
                            <div>
                              <div className="text-xs font-semibold text-indigo-600">{row.matchedLine?.name}</div>
                              <div className="flex items-center gap-1 text-emerald-700">
                                <span className="text-xs">✓</span>
                                <span className="text-xs">{row.matchedStop?.stop_name}</span>
                              </div>
                              {(row.orario || row.matchedStop?.pickup_time) && (
                                <div className="text-[10px] text-slate-400 mt-0.5">
                                  🕐 {row.orario || row.matchedStop?.pickup_time}
                                </div>
                              )}
                            </div>
                          )}
                          {row.status === "fuzzy" && (
                            <div>
                              <div className="text-xs font-semibold text-indigo-600">{row.matchedLine?.name}</div>
                              <div className="flex items-center gap-1 text-amber-700">
                                <span className="text-xs">~</span>
                                <span className="text-xs">{row.matchedStop?.stop_name}</span>
                              </div>
                              {(row.orario || row.matchedStop?.pickup_time) && (
                                <div className="text-[10px] text-slate-400 mt-0.5">
                                  🕐 {row.orario || row.matchedStop?.pickup_time}
                                </div>
                              )}
                            </div>
                          )}
                          {row.status === "pending" && (
                            <StopSearchSelect
                              rowIdx={i}
                              search={stopSearch[i] ?? ""}
                              onSearchChange={(v) => setStopSearch((prev) => ({ ...prev, [i]: v }))}
                              stopsByLine={stopsByLine}
                              onSelect={(stopId) => {
                                assignRowStop(i, stopId);
                                setStopSearch((prev) => ({ ...prev, [i]: "" }));
                              }}
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
              <button onClick={() => { setStep("upload"); setRows([]); setError(""); }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                ← Indietro
              </button>
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
