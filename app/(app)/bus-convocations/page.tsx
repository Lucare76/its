"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { EmptyState, PageHeader, SectionCard, StatCard } from "@/components/ui";
import { getClientSessionContext } from "@/lib/supabase/client-session";

type Step = "upload" | "preview" | "sending" | "results";

type ConvocationRow = {
  id: string;
  row_index: number;
  inviare: boolean;
  phone_raw: string;
  phone_e164: string | null;
  customer_name: string;
  date_line: string;
  departure_point: string;
  service_time: string;
  driver_name: string;
  driver_emergency_phone: string;
  generated_message: string;
  notes: string;
  status: string;
  error_message: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
};

type BatchMeta = {
  id: string;
  file_name: string;
  label: string;
  status: string;
  total_rows: number;
  sent_count: number;
  error_count: number;
  skipped_count: number;
  created_at: string;
};

type BatchListItem = BatchMeta & { created_by: string };

const COLUMN_KEYWORDS: Record<string, string[][]> = {
  inviare: [["inviare"], ["invio"], ["si/no"], ["send"]],
  phoneRaw: [["numero", "cliente"], ["telefono", "cliente"], ["tel", "cliente"], ["telefono"], ["cell"], ["phone"]],
  customerName: [["nome", "cliente"], ["cliente"], ["nominativo"], ["customer"], ["nome"]],
  dateLine: [["data", "partenza"], ["data", "linea"], ["data/linea"], ["linea", "bus"], ["data"]],
  departurePoint: [["luogo", "partenza"], ["punto", "partenza"], ["partenza"], ["pickup"], ["meeting"]],
  serviceTime: [["orario"], ["ora"], ["time"]],
  driverName: [["nome", "autista"], ["autista"], ["driver"]],
  driverEmergencyPhone: [["numero", "autista"], ["emergenza"], ["tel", "autista"], ["telefono", "autista"]],
  generatedMessage: [["messaggio", "finale"], ["messaggio", "generato"], ["messaggio"], ["message"]],
  notes: [["note"], ["notes"]],
};

const REQUIRED_FIELDS = ["phoneRaw", "customerName", "dateLine", "departurePoint", "serviceTime", "driverName", "driverEmergencyPhone"] as const;

function parseInviare(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim().toUpperCase();
  return ["SI", "SÌ", "S", "1", "TRUE", "X", "YES", "Y"].includes(s);
}

function normalizeHeader(s: string): string {
  return s.trim().toLowerCase().replace(/[\s\n\r]+/g, " ").replace(/[?!.:;]/g, "");
}

function findColumnIndex(header: string[], keywordSets: string[][]): number {
  const normalized = header.map(normalizeHeader);
  for (const keywords of keywordSets) {
    const idx = normalized.findIndex((h) => keywords.every((kw) => h.includes(kw.toLowerCase())));
    if (idx >= 0) return idx;
  }
  return -1;
}

function cellStr(row: unknown[], idx: number): string {
  if (idx < 0 || idx >= row.length) return "";
  const v = row[idx];
  if (v instanceof Date && !isNaN(v.getTime())) {
    const dd = String(v.getDate()).padStart(2, "0");
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const yyyy = v.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return String(v ?? "").trim();
}

function cellTime(row: unknown[], idx: number): string {
  if (idx < 0 || idx >= row.length) return "";
  const v = row[idx];
  if (typeof v === "number" && v >= 0 && v < 1) {
    const totalMinutes = Math.round(v * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    const hh = String(v.getHours()).padStart(2, "0");
    const mm = String(v.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const s = String(v ?? "").trim();
  if (/^\d{1,2}[:.]\d{2}$/.test(s)) return s.replace(".", ":");
  return s;
}

const STATUS_LABELS: Record<string, string> = {
  da_validare: "Da validare",
  pronto: "Pronto",
  da_inviare: "Da inviare",
  inviato: "Inviato",
  errore: "Errore",
  numero_non_valido: "N. non valido",
  duplicato: "Duplicato",
  escluso: "Escluso",
  da_reinviare: "Da reinviare",
};

const STATUS_COLORS: Record<string, string> = {
  pronto: "bg-blue-50 text-blue-700 border-blue-200",
  da_inviare: "bg-blue-50 text-blue-700 border-blue-200",
  inviato: "bg-emerald-50 text-emerald-700 border-emerald-200",
  errore: "bg-red-50 text-red-700 border-red-200",
  numero_non_valido: "bg-red-50 text-red-700 border-red-200",
  duplicato: "bg-amber-50 text-amber-700 border-amber-200",
  escluso: "bg-slate-100 text-slate-500 border-slate-200",
  da_reinviare: "bg-amber-50 text-amber-700 border-amber-200",
};

const ROW_BG: Record<string, string> = {
  inviato: "bg-emerald-50/40",
  errore: "bg-red-50/40",
  numero_non_valido: "bg-red-50/30",
  duplicato: "bg-amber-50/30",
  escluso: "opacity-50",
};

const TEMPLATE_TEXT = `Ciao {{1}} 👋

ti comunichiamo i dettagli della tua partenza del {{2}}.

📍 Luogo di partenza: {{3}}
⏰ Orario: {{4}}
🧔🏻‍♂️ Autista: {{5}} - {{6}}

⚠️ L'autista va contattato solo in caso di emergenza.
⚠️ Ti ricordiamo di presentarti almeno 15 minuti prima sul luogo di partenza.

Questo messaggio vale come conferma della partenza. Non seguiranno ulteriori comunicazioni.

🧳 È fondamentale che tutti i bagagli siano correttamente etichettati, con indicazione chiara dell'hotel di destinazione. I bagagli privi di etichetta non potranno essere presi in carico dal corriere.

In caso di errori, ti chiediamo di avvisarci tempestivamente.

Ischia Transfer Service`;

function buildPreview(row: { customerName: string; dateLine: string; departurePoint: string; serviceTime: string; driverName: string; driverEmergencyPhone: string }): string {
  return TEMPLATE_TEXT
    .replace("{{1}}", row.customerName)
    .replace("{{2}}", row.dateLine)
    .replace("{{3}}", row.departurePoint)
    .replace("{{4}}", row.serviceTime)
    .replace("{{5}}", row.driverName)
    .replace("{{6}}", row.driverEmergencyPhone);
}

type FilterKey = "all" | "pronto" | "escluso" | "duplicato" | "numero_non_valido" | "errore" | "inviato";

async function authHeaders(): Promise<Record<string, string>> {
  const ctx = await getClientSessionContext();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ctx.accessToken) h["Authorization"] = `Bearer ${ctx.accessToken}`;
  return h;
}

export default function BusConvocationsPage() {
  const [step, setStep] = useState<Step>("upload");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ConvocationRow[]>([]);
  const [batchMeta, setBatchMeta] = useState<BatchMeta | null>(null);
  const [sending, setSending] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4200);
  }, []);

  const loadBatch = useCallback(async (id: string) => {
    const headers = await authHeaders();
    const res = await fetch(`/api/ops/bus-convocations/${id}`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    setBatchMeta(data.batch);
    setRows(data.rows ?? []);
    setBatchId(id);
  }, []);

  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/bus-convocations/list", { headers });
      if (res.ok) {
        const data = await res.json();
        setBatches(data.batches ?? []);
      }
    } catch { /* ignore */ } finally {
      setLoadingBatches(false);
    }
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("Nessun foglio trovato nel file");

      const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (raw.length < 2) throw new Error("Il file deve contenere almeno un'intestazione e una riga dati");

      const FIELD_LABELS: Record<string, string> = {
        phoneRaw: "numero cliente", customerName: "nome cliente",
        dateLine: "data partenza", departurePoint: "luogo di partenza",
        serviceTime: "orario", driverName: "nome autista",
        driverEmergencyPhone: "numero autista",
      };

      let headerRowIndex = -1;
      let header: string[] = [];
      const colMap: Record<string, number> = {};

      for (let r = 0; r < Math.min(raw.length, 10); r++) {
        const candidate = (raw[r] as unknown[]).map((c) => String(c ?? "").trim());
        if (candidate.filter((c) => c.length > 0).length < 3) continue;
        const candidateMap: Record<string, number> = {};
        for (const [field, keywordSets] of Object.entries(COLUMN_KEYWORDS)) {
          candidateMap[field] = findColumnIndex(candidate, keywordSets);
        }
        const foundIndices = REQUIRED_FIELDS.map((f) => candidateMap[f]).filter((i) => i >= 0);
        const distinctIndices = new Set(foundIndices).size;
        if (foundIndices.length >= 5 && distinctIndices >= 5) {
          headerRowIndex = r;
          header = candidate;
          Object.assign(colMap, candidateMap);
          break;
        }
      }

      if (headerRowIndex < 0) {
        const firstRow = (raw[0] as unknown[]).map((c) => String(c ?? "").trim()).filter((h) => h.length > 0).join(", ");
        throw new Error(`Intestazioni colonne non trovate nelle prime righe del file.\n\nPrima riga: ${firstRow}`);
      }

      const missing = REQUIRED_FIELDS.filter((f) => colMap[f] < 0);
      if (missing.length > 0) {
        const foundHeaders = header.filter((h) => h.length > 0).join(", ");
        throw new Error(`Colonne non trovate: ${missing.map((f) => FIELD_LABELS[f] ?? f).join(", ")}.\n\nColonne trovate nel file: ${foundHeaders}`);
      }

      const parsedRows = [];
      for (let i = headerRowIndex + 1; i < raw.length; i++) {
        const r = raw[i] as unknown[];
        if (!r || r.every((c) => c == null || String(c).trim() === "")) continue;

        const customerName = cellStr(r, colMap.customerName);
        const dateLine = cellStr(r, colMap.dateLine);
        const departurePoint = cellStr(r, colMap.departurePoint);
        const serviceTime = cellTime(r, colMap.serviceTime);
        const driverName = cellStr(r, colMap.driverName);
        const driverEmergencyPhone = cellStr(r, colMap.driverEmergencyPhone);
        const phoneRaw = cellStr(r, colMap.phoneRaw);

        const inviare = colMap.inviare >= 0 ? parseInviare(r[colMap.inviare]) : true;

        const preview = buildPreview({ customerName, dateLine, departurePoint, serviceTime, driverName, driverEmergencyPhone });

        parsedRows.push({
          rowIndex: i + 1,
          inviare,
          phoneRaw,
          customerName,
          dateLine,
          departurePoint,
          serviceTime,
          driverName,
          driverEmergencyPhone,
          generatedMessage: preview,
          notes: colMap.notes >= 0 ? cellStr(r, colMap.notes) : "",
        });
      }

      if (parsedRows.length === 0) throw new Error("Nessuna riga dati valida trovata");

      const headers = await authHeaders();
      const res = await fetch("/api/ops/bus-convocations/upload", {
        method: "POST",
        headers,
        body: JSON.stringify({ fileName: file.name, rows: parsedRows }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Errore upload");

      await loadBatch(data.batchId);
      setStep("preview");
      showToast(`${parsedRows.length} righe caricate e validate`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Errore lettura file");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }, [loadBatch, showToast]);

  const filteredRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "errore") return rows.filter((r) => r.status === "errore" || r.status === "numero_non_valido");
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const stats = useMemo(() => {
    const s = { total: rows.length, pronto: 0, da_inviare: 0, escluso: 0, duplicato: 0, non_valido: 0, errore: 0, inviato: 0 };
    for (const r of rows) {
      if (r.status === "pronto" || r.status === "da_inviare") s.pronto++;
      else if (r.status === "escluso") s.escluso++;
      else if (r.status === "duplicato") s.duplicato++;
      else if (r.status === "numero_non_valido") s.non_valido++;
      else if (r.status === "errore") s.errore++;
      else if (r.status === "inviato") s.inviato++;
    }
    return s;
  }, [rows]);

  const updateRowStatuses = useCallback(async (updates: Array<{ rowId: string; status: string }>) => {
    if (!batchId || updates.length === 0) return;
    const headers = await authHeaders();
    await fetch(`/api/ops/bus-convocations/${batchId}/rows`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ updates }),
    });
    await loadBatch(batchId);
  }, [batchId, loadBatch]);

  const selectAllReady = useCallback(async () => {
    const toUpdate = rows.filter((r) => r.status === "pronto").map((r) => ({ rowId: r.id, status: "da_inviare" }));
    await updateRowStatuses(toUpdate);
    showToast(`${toUpdate.length} righe selezionate per l'invio`);
  }, [rows, updateRowStatuses, showToast]);

  const deselectAll = useCallback(async () => {
    const toUpdate = rows.filter((r) => r.status === "da_inviare").map((r) => ({ rowId: r.id, status: "pronto" }));
    await updateRowStatuses(toUpdate);
    showToast("Selezione rimossa");
  }, [rows, updateRowStatuses, showToast]);

  const handleSend = useCallback(async () => {
    if (!batchId) return;

    const readyRows = rows.filter((r) => r.status === "pronto");
    if (readyRows.length > 0) {
      await updateRowStatuses(readyRows.map((r) => ({ rowId: r.id, status: "da_inviare" })));
    }

    setSending(true);
    setStep("sending");

    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/bus-convocations/send", {
        method: "POST",
        headers,
        body: JSON.stringify({ batchId }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Errore invio");

      await loadBatch(batchId);
      setStep("results");
      showToast(`Invio completato: ${data.sent} inviati, ${data.failed} errori`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Errore invio");
      await loadBatch(batchId);
      setStep("results");
    } finally {
      setSending(false);
    }
  }, [batchId, rows, updateRowStatuses, loadBatch, showToast]);

  const handleRetrySend = useCallback(async () => {
    if (!batchId) return;
    const errorRows = rows.filter((r) => r.status === "errore");
    if (errorRows.length === 0) { showToast("Nessuna riga in errore da reinviare"); return; }

    await updateRowStatuses(errorRows.map((r) => ({ rowId: r.id, status: "da_reinviare" })));

    setSending(true);
    setStep("sending");
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/bus-convocations/send", {
        method: "POST",
        headers,
        body: JSON.stringify({ batchId }),
      });
      const data = await res.json();
      await loadBatch(batchId);
      setStep("results");
      showToast(`Reinvio completato: ${data.sent ?? 0} inviati, ${data.failed ?? 0} errori`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Errore reinvio");
      await loadBatch(batchId);
      setStep("results");
    } finally {
      setSending(false);
    }
  }, [batchId, rows, updateRowStatuses, loadBatch, showToast]);

  const handleDownloadReport = useCallback(async () => {
    if (!batchId) return;
    setDownloading(true);
    try {
      const headers = await authHeaders();
      delete headers["Content-Type"];
      const res = await fetch(`/api/ops/bus-convocations/report?batchId=${batchId}`, { headers });
      if (!res.ok) throw new Error("Errore download report");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const disposition = res.headers.get("content-disposition");
      const match = disposition?.match(/filename="?([^"]+)"?/i);
      link.download = match?.[1] ?? "report_convocazioni.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Errore download");
    } finally {
      setDownloading(false);
    }
  }, [batchId, showToast]);

  const resetToUpload = useCallback(() => {
    setStep("upload");
    setBatchId(null);
    setRows([]);
    setBatchMeta(null);
    setFilter("all");
    setExpandedRow(null);
    setUploadError(null);
    loadBatches();
  }, [loadBatches]);

  const openBatchResults = useCallback(async (id: string) => {
    await loadBatch(id);
    setStep("results");
    setFilter("all");
  }, [loadBatch]);

  const sendableCount = rows.filter((r) => r.status === "pronto" || r.status === "da_inviare").length;

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Convocazioni Bus"
        subtitle="Invio massivo convocazioni bus via WhatsApp da file Excel"
        breadcrumbs={[{ label: "Strumenti" }, { label: "Convocazioni Bus" }]}
        actions={
          step !== "upload" && step !== "sending" ? (
            <button className="btn-secondary text-sm" onClick={resetToUpload}>
              Nuovo batch
            </button>
          ) : undefined
        }
      />

      {/* STEP 1: UPLOAD */}
      {step === "upload" && (
        <SectionCard title="Carica file Excel" subtitle="Seleziona il file .xlsx con i dati delle convocazioni bus">
          <div className="space-y-4">
            <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/50 p-8 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="12" y2="12" />
                  <line x1="15" y1="15" x2="12" y2="12" />
                </svg>
              </div>
              <label className="btn-primary inline-flex cursor-pointer items-center gap-2 px-6 py-2.5 text-sm">
                {uploading ? "Caricamento..." : "Seleziona file Excel"}
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={handleFileSelect}
                  disabled={uploading}
                />
              </label>
              <p className="mt-3 text-xs text-muted">
                Formati accettati: .xlsx, .xls
              </p>
            </div>

            {uploadError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {uploadError}
              </div>
            )}

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="mb-2 text-sm font-medium text-slate-700">Colonne richieste nel file:</p>
              <div className="grid grid-cols-2 gap-1 text-xs text-slate-600 sm:grid-cols-3">
                <span>Nome cliente</span>
                <span>Numero cliente</span>
                <span>Data partenza</span>
                <span>Luogo di partenza</span>
                <span>Orario</span>
                <span>Nome autista</span>
                <span>Numero autista</span>
              </div>
              <p className="mt-2 text-xs text-muted">
                Opzionali: Inviare? (SI/NO), Note, Messaggio finale
              </p>
            </div>
          </div>
        </SectionCard>
      )}

      {/* STEP 2: PREVIEW */}
      {step === "preview" && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Totale righe" value={String(stats.total)} hint="Righe nel file" />
            <StatCard label="Pronte" value={String(stats.pronto)} hint="Pronte per l'invio" />
            <StatCard label="Escluse" value={String(stats.escluso)} hint="Inviare? = NO" />
            <StatCard label="Non valide" value={String(stats.non_valido)} hint="Numero non valido" />
            <StatCard label="Duplicate" value={String(stats.duplicato)} hint="Stessa riga nel batch" />
            <StatCard label="Errori" value={String(stats.errore)} hint="Campi mancanti" />
          </div>

          <SectionCard
            title="Anteprima righe"
            subtitle={batchMeta ? `File: ${batchMeta.file_name}` : undefined}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-secondary text-xs" onClick={selectAllReady}>
                  Seleziona tutte le pronte
                </button>
                <button className="btn-secondary text-xs" onClick={deselectAll}>
                  Deseleziona tutte
                </button>
                <button
                  className="btn-primary text-xs px-4"
                  disabled={sendableCount === 0}
                  onClick={handleSend}
                >
                  Conferma e Invia ({sendableCount})
                </button>
              </div>
            }
          >
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(["all", "pronto", "escluso", "duplicato", "numero_non_valido", "errore"] as FilterKey[]).map((key) => (
                <button
                  key={key}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    filter === key
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                  onClick={() => setFilter(key)}
                >
                  {key === "all" ? "Tutte" : STATUS_LABELS[key] ?? key}
                  {key === "all" ? ` (${rows.length})` : ` (${rows.filter((r) => key === "errore" ? (r.status === "errore" || r.status === "numero_non_valido") : r.status === key).length})`}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="premium-table w-full text-sm">
                <thead>
                  <tr>
                    <th className="w-10 text-center">#</th>
                    <th>Cliente</th>
                    <th>Telefono</th>
                    <th>Data partenza</th>
                    <th>Luogo partenza</th>
                    <th>Orario</th>
                    <th>Autista</th>
                    <th>Tel autista</th>
                    <th className="w-32">Stato</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-8 text-center text-muted">Nessuna riga con questo filtro</td>
                    </tr>
                  ) : filteredRows.map((row) => (
                    <>
                      <tr key={row.id} className={ROW_BG[row.status] ?? ""}>
                        <td className="text-center text-xs text-muted">{row.row_index}</td>
                        <td className="font-medium">{row.customer_name}</td>
                        <td className="font-mono text-xs">{row.phone_raw}{row.phone_e164 ? <span className="ml-1 text-muted">({row.phone_e164})</span> : null}</td>
                        <td>{row.date_line}</td>
                        <td>{row.departure_point}</td>
                        <td>{row.service_time}</td>
                        <td>{row.driver_name}</td>
                        <td className="font-mono text-xs">{row.driver_emergency_phone}</td>
                        <td>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[row.status] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                            {STATUS_LABELS[row.status] ?? row.status}
                          </span>
                          {row.error_message ? <p className="mt-0.5 text-xs text-red-600">{row.error_message}</p> : null}
                        </td>
                        <td className="text-center">
                          <button
                            className="text-muted hover:text-text"
                            title="Anteprima messaggio"
                            onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                          >
                            {expandedRow === row.id ? "▲" : "▼"}
                          </button>
                        </td>
                      </tr>
                      {expandedRow === row.id && (
                        <tr key={`${row.id}-preview`}>
                          <td colSpan={10} className="bg-slate-50 px-4 py-3">
                            <p className="mb-1 text-xs font-medium text-muted">Anteprima messaggio (template Meta):</p>
                            <pre className="whitespace-pre-wrap rounded-lg bg-white border border-slate-200 p-3 text-sm leading-relaxed">
                              {row.generated_message || buildPreview({
                                customerName: row.customer_name,
                                dateLine: row.date_line,
                                departurePoint: row.departure_point,
                                serviceTime: row.service_time,
                                driverName: row.driver_name,
                                driverEmergencyPhone: row.driver_emergency_phone,
                              })}
                            </pre>
                            {(row.status === "pronto" || row.status === "da_inviare" || row.status === "duplicato") && (
                              <div className="mt-2 flex gap-2">
                                {row.status !== "da_inviare" && (
                                  <button
                                    className="rounded border border-blue-300 bg-blue-50 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100"
                                    onClick={() => updateRowStatuses([{ rowId: row.id, status: "da_inviare" }])}
                                  >
                                    Includi nell&apos;invio
                                  </button>
                                )}
                                <button
                                  className="rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                  onClick={() => updateRowStatuses([{ rowId: row.id, status: "escluso" }])}
                                >
                                  Escludi
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}

      {/* STEP 3: SENDING */}
      {step === "sending" && (
        <SectionCard title="Invio in corso">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
            <p className="text-lg font-medium text-slate-700">Invio convocazioni in corso...</p>
            <p className="mt-2 text-sm text-muted">Non chiudere questa pagina. L&apos;invio potrebbe richiedere alcuni minuti.</p>
          </div>
        </SectionCard>
      )}

      {/* STEP 4: RESULTS */}
      {step === "results" && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Totale" value={String(stats.total)} hint="Righe totali" />
            <StatCard label="Inviati" value={String(stats.inviato)} hint="Messaggi inviati" />
            <StatCard label="Errori" value={String(stats.errore + stats.non_valido)} hint="Invii falliti" />
            <StatCard label="Esclusi" value={String(stats.escluso + stats.duplicato)} hint="Non inviati" />
          </div>

          <SectionCard
            title="Risultati invio"
            subtitle={batchMeta ? `Batch: ${batchMeta.file_name} — ${new Date(batchMeta.created_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" })}` : undefined}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {stats.errore > 0 && (
                  <button className="btn-secondary text-xs" onClick={handleRetrySend} disabled={sending}>
                    Reinvia errori ({stats.errore})
                  </button>
                )}
                <button
                  className="btn-primary text-xs px-4"
                  onClick={handleDownloadReport}
                  disabled={downloading}
                >
                  {downloading ? "Download..." : "Scarica Report"}
                </button>
              </div>
            }
          >
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(["all", "inviato", "errore", "escluso", "duplicato"] as FilterKey[]).map((key) => (
                <button
                  key={key}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    filter === key
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                  onClick={() => setFilter(key)}
                >
                  {key === "all" ? "Tutte" : STATUS_LABELS[key] ?? key}
                  {key === "all" ? ` (${rows.length})` : ` (${rows.filter((r) => key === "errore" ? (r.status === "errore" || r.status === "numero_non_valido") : r.status === key).length})`}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="premium-table w-full text-sm">
                <thead>
                  <tr>
                    <th className="w-10">#</th>
                    <th>Cliente</th>
                    <th>Telefono</th>
                    <th>Data partenza</th>
                    <th>Luogo partenza</th>
                    <th>Orario</th>
                    <th>Autista</th>
                    <th className="w-32">Stato</th>
                    <th>Inviato alle</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-muted">Nessuna riga con questo filtro</td>
                    </tr>
                  ) : filteredRows.map((row) => (
                    <tr key={row.id} className={ROW_BG[row.status] ?? ""}>
                      <td className="text-center text-xs text-muted">{row.row_index}</td>
                      <td className="font-medium">{row.customer_name}</td>
                      <td className="font-mono text-xs">{row.phone_e164 ?? row.phone_raw}</td>
                      <td>{row.date_line}</td>
                      <td>{row.departure_point}</td>
                      <td>{row.service_time}</td>
                      <td>{row.driver_name}</td>
                      <td>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[row.status] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                          {STATUS_LABELS[row.status] ?? row.status}
                        </span>
                        {row.error_message ? <p className="mt-0.5 text-xs text-red-600">{row.error_message}</p> : null}
                      </td>
                      <td className="text-xs text-muted">
                        {row.sent_at ? new Date(row.sent_at).toLocaleString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}

      {/* STORICO BATCH */}
      {step === "upload" && (
        <SectionCard title="Storico batch" subtitle="Batch caricati in precedenza">
          {loadingBatches ? (
            <div className="py-4 text-center text-sm text-muted">Caricamento...</div>
          ) : batches.length === 0 ? (
            <EmptyState title="Nessun batch" description="Non ci sono batch precedenti." />
          ) : (
            <div className="overflow-x-auto">
              <table className="premium-table w-full text-sm">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>File</th>
                    <th>Righe</th>
                    <th>Inviati</th>
                    <th>Errori</th>
                    <th>Stato</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td className="text-xs">{new Date(b.created_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" })}</td>
                      <td>{b.file_name}</td>
                      <td className="text-center">{b.total_rows}</td>
                      <td className="text-center text-emerald-600">{b.sent_count}</td>
                      <td className="text-center text-red-600">{b.error_count}</td>
                      <td>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          b.status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                          b.status === "error" ? "bg-red-50 text-red-700 border-red-200" :
                          "bg-slate-100 text-slate-600 border-slate-200"
                        }`}>
                          {b.status === "completed" ? "Completato" : b.status === "ready" ? "Pronto" : b.status === "sending" ? "In invio" : b.status}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                          onClick={() => openBatchResults(b.id)}
                        >
                          Apri
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {/* TOAST */}
      {toastMessage && (
        <div className="fixed bottom-4 right-4 z-[60] rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
