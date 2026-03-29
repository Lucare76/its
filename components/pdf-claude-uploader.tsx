"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";

// ─── Tipi ──────────────────────────────────────────────────────────────────

type ExtractedService = {
  data: string | null;
  tipo: string | null;
  mezzo: string | null;
  compagnia: string | null;
  numero_mezzo: string | null;
  orario: string | null;
  partenza: string | null;
  destinazione: string | null;
  importo: number | null;
  totale: number | null;
};

type ExtractedData = {
  agenzia: string | null;
  numero_conferma: string | null;
  numero_pratica: string | null;
  data_conferma: string | null;
  cliente_nome: string | null;
  cliente_cellulare: string | null;
  n_pax: number | null;
  hotel: string | null;
  data_arrivo: string | null;
  data_partenza: string | null;
  servizi: ExtractedService[];
  totale_pratica: number | null;
  note_operative: string | null;
};

type Step = "idle" | "loading_detect" | "loading_extract" | "done" | "error";

const AGENCY_LABELS: Record<string, string> = {
  aleste: "Aleste Viaggi",
  angelino: "Angelino Tour & Events",
  holidayweb: "Holiday Web",
  sosandra: "Sosandra / Rossella Viaggi",
  zigolo: "Zigolo Viaggi",
  unknown: "Agenzia non identificata"
};

// ─── Helpers ───────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64 ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fmt(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);
}

// ─── Sotto-componente: campo del form pre-compilato ────────────────────────

function Field({
  label,
  value,
  required = false
}: {
  label: string;
  value: string | null | undefined;
  required?: boolean;
}) {
  const missing = required && (value === null || value === undefined || value === "");
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <div
        className={`mt-1 rounded-xl border px-3 py-2 text-sm ${
          missing
            ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-950/30 dark:text-amber-300"
            : "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        }`}
      >
        {value ?? <span className="italic opacity-60">Da compilare</span>}
      </div>
    </div>
  );
}

// ─── Componente principale ─────────────────────────────────────────────────

export function PdfClaudeUploader() {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [agency, setAgency] = useState<string | null>(null);
  const [data, setData] = useState<ExtractedData | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function process(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Seleziona un file PDF.");
      return;
    }

    setStep("loading_detect");
    setError(null);
    setAgency(null);
    setData(null);
    setSavedId(null);
    setFilename(file.name);

    const token = await getAccessToken();
    if (!token) {
      setStep("error");
      setError("Sessione scaduta. Ricarica la pagina.");
      return;
    }

    let base64: string;
    try {
      base64 = await fileToBase64(file);
      setPdfBase64(base64);
    } catch {
      setStep("error");
      setError("Errore nella lettura del file.");
      return;
    }

    // ── Chiamata 1: riconoscimento agenzia ────────────────────────────────
    let detectedAgency = "unknown";
    try {
      const res = await fetch("/api/pdf/claude-extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ pdf_base64: base64, step: "detect" })
      });
      const body = (await res.json()) as { ok?: boolean; agency?: string; error?: string };
      if (!res.ok || !body.ok) {
        setStep("error");
        setError(body.error ?? `Errore HTTP ${res.status}`);
        return;
      }
      detectedAgency = body.agency ?? "unknown";
    } catch (fetchError) {
      setStep("error");
      setError(fetchError instanceof Error ? fetchError.message : "Errore di rete.");
      return;
    }

    setAgency(detectedAgency);
    setStep("loading_extract");

    // ── Chiamata 2: estrazione dati ────────────────────────────────────────
    try {
      const res = await fetch("/api/pdf/claude-extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ pdf_base64: base64, step: "extract", agency: detectedAgency })
      });
      const body = (await res.json()) as { ok?: boolean; data?: ExtractedData; error?: string };
      if (!res.ok || !body.ok || !body.data) {
        setStep("error");
        setError(body.error ?? `Errore HTTP ${res.status}`);
        return;
      }
      setData(body.data);
      setStep("done");
    } catch (fetchError) {
      setStep("error");
      setError(fetchError instanceof Error ? fetchError.message : "Errore di rete.");
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) void process(file);
  }

  async function saveDraft() {
    if (!data || !agency) return;
    setSaveError(null);
    const token = await getAccessToken();
    if (!token) { setSaveError("Sessione scaduta. Ricarica la pagina."); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/pdf/claude-save-draft", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ extracted: data, pdf_base64: pdfBase64, filename, agency })
      });
      let body: { ok?: boolean; inbound_email_id?: string; draft_service_id?: string; error?: string } = {};
      try { body = await res.json(); } catch { /* empty */ }
      if (!res.ok || !body.ok) {
        setSaveError(body.error ?? `Errore HTTP ${res.status} — controlla la console per dettagli.`);
      } else {
        setSavedId(body.inbound_email_id ?? "ok");
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Errore di rete.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setStep("idle");
    setError(null);
    setSaveError(null);
    setAgency(null);
    setData(null);
    setPdfBase64(null);
    setSavedId(null);
    setFilename(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy = step === "loading_detect" || step === "loading_extract";

  return (
    <article className="card overflow-hidden">
      {/* Header accordion */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Nuovo</p>
          <h2 className="mt-0.5 text-base font-semibold text-slate-950 dark:text-white">
            Importa PDF con Claude AI
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {step === "done" && (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
              Estratto
            </span>
          )}
          <svg
            className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-200 p-5 space-y-5 dark:border-slate-700">

          {/* Drop zone */}
          {(step === "idle" || step === "error") && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
                dragOver
                  ? "border-blue-400 bg-blue-50 dark:bg-blue-950/20"
                  : "border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800/40"
              }`}
            >
              <svg className="h-10 w-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Trascina il PDF qui o clicca per selezionarlo
                </p>
                <p className="mt-1 text-xs text-slate-500">Supporta tutti i formati PDF — anche encoding non standard</p>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
          )}

          {/* Stato: riconoscimento agenzia */}
          {step === "loading_detect" && (
            <div className="flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4 dark:border-blue-800 dark:bg-blue-950/20">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              <div>
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">Riconoscimento agenzia...</p>
                <p className="text-xs text-blue-600 dark:text-blue-400">{filename}</p>
              </div>
            </div>
          )}

          {/* Stato: estrazione dati */}
          {step === "loading_extract" && (
            <div className="flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4 dark:border-blue-800 dark:bg-blue-950/20">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              <div>
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                  Estrazione dati —{" "}
                  <span className="font-bold">{AGENCY_LABELS[agency ?? "unknown"]}</span>
                </p>
                <p className="text-xs text-blue-600 dark:text-blue-400">Claude sta leggendo il documento...</p>
              </div>
            </div>
          )}

          {/* Errore */}
          {step === "error" && error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/20 dark:text-rose-300">
              {error}
            </div>
          )}

          {/* Risultato estratto */}
          {step === "done" && data && (
            <div className="space-y-5">
              {/* Intestazione agenzia */}
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
                  {AGENCY_LABELS[agency ?? "unknown"] ?? agency}
                </span>
                {data.numero_pratica && (
                  <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:border-blue-700 dark:bg-blue-950/20 dark:text-blue-300">
                    Pratica {data.numero_pratica}
                  </span>
                )}
                {data.numero_conferma && (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 dark:border-slate-600 dark:bg-slate-800">
                    Conf. n. {data.numero_conferma}
                  </span>
                )}
                <div className="ml-auto">
                  <p className="text-[10px] text-slate-400">
                    Campi arancioni = da completare a mano
                  </p>
                </div>
              </div>

              {/* Dati cliente */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Cliente</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Nome" value={data.cliente_nome} required />
                  <Field label="Cellulare" value={data.cliente_cellulare} required />
                  <Field label="N. Pax" value={data.n_pax !== null ? String(data.n_pax) : null} />
                </div>
              </div>

              {/* Soggiorno */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Soggiorno</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Hotel" value={data.hotel} required />
                  <Field label="Data arrivo" value={data.data_arrivo} required />
                  <Field label="Data partenza" value={data.data_partenza} required />
                </div>
              </div>

              {/* Servizi */}
              {data.servizi && data.servizi.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/50">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                    Servizi ({data.servizi.length})
                  </p>
                  <div className="space-y-3">
                    {data.servizi.map((service, index) => (
                      <div
                        key={index}
                        className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-slate-900 dark:text-white">
                              {service.tipo ?? <span className="italic text-slate-400">Tipo N/D</span>}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {[service.data, service.orario].filter(Boolean).join(" • ")}
                              {service.partenza && service.destinazione
                                ? ` — ${service.partenza} → ${service.destinazione}`
                                : service.partenza
                                ? ` — da ${service.partenza}`
                                : ""}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {[service.mezzo, service.compagnia, service.numero_mezzo].filter(Boolean).join(" / ")}
                            </p>
                          </div>
                          {(service.importo !== null || service.totale !== null) && (
                            <div className="text-right">
                              {service.totale !== null && (
                                <p className="text-sm font-semibold text-slate-900 dark:text-white">{fmt(service.totale)}</p>
                              )}
                              {service.importo !== null && service.importo !== service.totale && (
                                <p className="text-xs text-slate-500">{fmt(service.importo)} base</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Totale e note */}
              <div className="grid gap-3 sm:grid-cols-2">
                {data.totale_pratica !== null && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/50">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Totale pratica</p>
                    <p className="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">{fmt(data.totale_pratica)}</p>
                  </div>
                )}
                {data.note_operative && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/50 sm:col-span-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Note operative</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{data.note_operative}</p>
                  </div>
                )}
              </div>

              {/* Errore salvataggio */}
              {saveError && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/20 dark:text-rose-300">
                  {saveError}
                </div>
              )}

              {/* Azioni */}
              <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
                {savedId ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700">
                      Bozza creata
                    </span>
                    <a href="/pdf-imports" className="btn-secondary px-4 py-2 text-sm">
                      Vai a Revisione PDF
                    </a>
                    <a href="/arrivals" className="btn-secondary px-4 py-2 text-sm">
                      Vai agli Arrivi
                    </a>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void saveDraft()}
                    disabled={saving}
                    className="btn-primary px-5 py-2 text-sm disabled:opacity-60"
                  >
                    {saving ? "Salvataggio..." : "Crea bozza servizio"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(JSON.stringify(data, null, 2)).catch(() => null); }}
                  className="btn-secondary px-4 py-2 text-sm"
                >
                  Copia JSON
                </button>
                <button type="button" onClick={reset} className="btn-secondary px-4 py-2 text-sm">
                  Carica altro PDF
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
