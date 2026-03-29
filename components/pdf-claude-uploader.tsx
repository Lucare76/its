"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";

// ─── Tipi ──────────────────────────────────────────────────────────────────

type Step = "idle" | "detecting" | "extracting" | "form" | "saving" | "done" | "error";

type FormState = {
  cliente_nome: string;
  cliente_cellulare: string;
  n_pax: string;
  hotel: string;
  data_arrivo: string;
  orario_arrivo: string;
  data_partenza: string;
  orario_partenza: string;
  tipo_servizio: string;
  treno_andata: string;
  treno_ritorno: string;
  citta_partenza: string;
  totale_pratica: string;
  note: string;
  numero_pratica: string;
  agenzia: string;
};

const EMPTY_FORM: FormState = {
  cliente_nome: "", cliente_cellulare: "", n_pax: "1",
  hotel: "", data_arrivo: "", orario_arrivo: "", data_partenza: "", orario_partenza: "",
  tipo_servizio: "transfer_station_hotel", treno_andata: "", treno_ritorno: "",
  citta_partenza: "", totale_pratica: "", note: "", numero_pratica: "", agenzia: ""
};

const TIPO_LABELS: Record<string, string> = {
  transfer_station_hotel: "Transfer Stazione / Hotel",
  transfer_airport_hotel: "Transfer Aeroporto / Hotel",
  transfer_port_hotel: "Transfer Porto / Hotel",
  excursion: "Escursione"
};

const AGENCY_LABELS: Record<string, string> = {
  aleste: "Aleste Viaggi", angelino: "Angelino Tour & Events",
  holidayweb: "Holiday Web", sosandra: "Sosandra / Rossella Viaggi",
  zigolo: "Zigolo Viaggi", unknown: "Agenzia non identificata"
};

// ─── Helpers ───────────────────────────────────────────────────────────────

async function getToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = typeof reader.result === "string" ? reader.result : "";
      resolve(r.includes(",") ? r.split(",")[1] : r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type ExtractedService = { orario?: string | null; numero_mezzo?: string | null; partenza?: string | null; compagnia?: string | null; tipo?: string | null; mezzo?: string | null };
type ClaudeJson = {
  cliente_nome?: string | null; cliente_cellulare?: string | null; n_pax?: number | null;
  hotel?: string | null; data_arrivo?: string | null; data_partenza?: string | null;
  totale_pratica?: number | null; note_operative?: string | null; numero_pratica?: string | null;
  agenzia?: string | null; servizi?: ExtractedService[];
};

function deduceTipo(servizi: ExtractedService[] = [], agency: string): string {
  const text = servizi.map((s) => `${s.tipo ?? ""} ${s.mezzo ?? ""} ${s.compagnia ?? ""}`).join(" ").toUpperCase();
  if (/AEROPORTO/.test(text)) return "transfer_airport_hotel";
  if (/STAZIONE|ITALO|TRENITALIA|FLIXBUS/.test(text)) return "transfer_station_hotel";
  if (/PORTO|TRAGHETTO|ALISCAFO/.test(text)) return "transfer_port_hotel";
  if (agency === "aleste" || agency === "zigolo") return "transfer_station_hotel";
  return "transfer_port_hotel";
}

function claudeToForm(json: ClaudeJson, agency: string): FormState {
  const servizi = json.servizi ?? [];
  const andata = servizi[0] ?? null;
  const ritorno = servizi.find((s, i) => i > 0 && /ritorno|hotel.st|hotel.ae|hotel.po/i.test(s.tipo ?? "")) ?? servizi[1] ?? null;
  return {
    cliente_nome: json.cliente_nome ?? "",
    cliente_cellulare: json.cliente_cellulare ?? "",
    n_pax: String(json.n_pax ?? 1),
    hotel: json.hotel ?? "",
    data_arrivo: json.data_arrivo ?? "",
    orario_arrivo: andata?.orario ?? "",
    data_partenza: json.data_partenza ?? "",
    orario_partenza: ritorno?.orario ?? "",
    tipo_servizio: deduceTipo(servizi, agency),
    treno_andata: andata?.numero_mezzo ?? "",
    treno_ritorno: ritorno?.numero_mezzo ?? "",
    citta_partenza: andata?.partenza ?? "",
    totale_pratica: json.totale_pratica ? String(json.totale_pratica) : "",
    note: json.note_operative ?? "",
    numero_pratica: json.numero_pratica ?? "",
    agenzia: AGENCY_LABELS[agency] ?? json.agenzia ?? agency
  };
}

// ─── Componente ────────────────────────────────────────────────────────────

export function PdfClaudeUploader() {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [agency, setAgency] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState(false);
  const [savedServiceId, setSavedServiceId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function set(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function process(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) { setError("Seleziona un file PDF."); return; }
    setStep("detecting"); setError(null); setSavedServiceId(null); setFilename(file.name);

    const token = await getToken();
    if (!token) { setStep("error"); setError("Sessione scaduta."); return; }

    let base64: string;
    try { base64 = await fileToBase64(file); setPdfBase64(base64); }
    catch { setStep("error"); setError("Errore lettura file."); return; }

    // ── Riconoscimento agenzia ────────────────────────────────────────────
    let detectedAgency = "unknown";
    try {
      const res = await fetch("/api/pdf/claude-extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ pdf_base64: base64, step: "detect" })
      });
      const body = (await res.json()) as { ok?: boolean; agency?: string; error?: string };
      if (!res.ok || !body.ok) { setStep("error"); setError(body.error ?? `Errore HTTP ${res.status}`); return; }
      detectedAgency = body.agency ?? "unknown";
    } catch (e) { setStep("error"); setError(e instanceof Error ? e.message : "Errore di rete."); return; }

    setAgency(detectedAgency);
    setStep("extracting");

    // ── Estrazione dati ───────────────────────────────────────────────────
    try {
      const res = await fetch("/api/pdf/claude-extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ pdf_base64: base64, step: "extract", agency: detectedAgency })
      });
      const body = (await res.json()) as { ok?: boolean; data?: ClaudeJson; error?: string };
      if (!res.ok || !body.ok || !body.data) { setStep("error"); setError(body.error ?? `Errore HTTP ${res.status}`); return; }
      setForm(claudeToForm(body.data, detectedAgency));
      setStep("form");
    } catch (e) { setStep("error"); setError(e instanceof Error ? e.message : "Errore di rete."); }
  }

  async function save() {
    const token = await getToken();
    if (!token) { setError("Sessione scaduta."); return; }
    setStep("saving"); setError(null);
    try {
      const res = await fetch("/api/pdf/claude-save-draft", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ form, pdf_base64: pdfBase64, filename, agency, confirm: true })
      });
      let body: { ok?: boolean; draft_service_id?: string; error?: string } = {};
      try { body = await res.json(); } catch { /* empty */ }
      if (!res.ok || !body.ok) { setStep("form"); setError(body.error ?? `Errore HTTP ${res.status}`); }
      else { setSavedServiceId(body.draft_service_id ?? "ok"); setStep("done"); }
    } catch (e) { setStep("form"); setError(e instanceof Error ? e.message : "Errore di rete."); }
  }

  function reset() {
    setStep("idle"); setError(null); setAgency(null); setForm(EMPTY_FORM);
    setPdfBase64(null); setSavedServiceId(null); setFilename(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy = step === "detecting" || step === "extracting" || step === "saving";

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <article className="card overflow-hidden">
      {/* Header */}
      <button type="button" onClick={() => setOpen((p) => !p)} className="flex w-full items-center justify-between px-5 py-4 text-left">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Nuovo servizio</p>
          <h2 className="mt-0.5 text-base font-semibold text-slate-950 dark:text-white">Importa PDF agenzia</h2>
        </div>
        <div className="flex items-center gap-3">
          {step === "done" && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">Servizio salvato</span>}
          {(step === "detecting" || step === "extracting") && <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">Lettura in corso...</span>}
          <svg className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-200 dark:border-slate-700">

          {/* ── STEP: drop zone ─────────────────────────────────────────── */}
          {(step === "idle" || step === "error") && (
            <div className="p-5 space-y-3">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); void process(e.dataTransfer.files[0]); }}
                onClick={() => inputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
                  dragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800/40"
                }`}
              >
                <svg className="h-10 w-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Trascina il PDF qui o clicca per selezionarlo</p>
                  <p className="mt-1 text-xs text-slate-500">Legge automaticamente tutte le agenzie — anche font non standard</p>
                </div>
                <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => { if (e.target.files?.[0]) void process(e.target.files[0]); }} />
              </div>
              {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
            </div>
          )}

          {/* ── STEP: lettura in corso ───────────────────────────────────── */}
          {(step === "detecting" || step === "extracting") && (
            <div className="p-5">
              <div className="flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                <div>
                  <p className="text-sm font-semibold text-blue-800">
                    {step === "detecting" ? "Identificazione agenzia..." : `Estrazione dati — ${AGENCY_LABELS[agency ?? "unknown"] ?? agency}`}
                  </p>
                  <p className="text-xs text-blue-600">{filename}</p>
                </div>
              </div>
            </div>
          )}

          {/* ── STEP: form editabile ─────────────────────────────────────── */}
          {(step === "form" || step === "saving") && (
            <div className="p-5 space-y-5">

              {/* Agenzia rilevata */}
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600 dark:border-slate-600 dark:bg-slate-800">
                  {AGENCY_LABELS[agency ?? "unknown"] ?? agency}
                </span>
                {form.numero_pratica && (
                  <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                    Pratica {form.numero_pratica}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-slate-400">Verifica i campi e salva</span>
              </div>

              {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

              {/* Cliente */}
              <section className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Cliente</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Nome *
                    <input value={form.cliente_nome} onChange={(e) => set("cliente_nome", e.target.value)}
                      className={`mt-1 input-saas w-full ${!form.cliente_nome ? "border-amber-300 bg-amber-50" : ""}`}
                      placeholder="Nome cognome" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Cellulare *
                    <input value={form.cliente_cellulare} onChange={(e) => set("cliente_cellulare", e.target.value)}
                      className={`mt-1 input-saas w-full ${!form.cliente_cellulare ? "border-amber-300 bg-amber-50" : ""}`}
                      placeholder="Es. 3281234567" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    N. Pax
                    <input type="number" min="1" max="99" value={form.n_pax} onChange={(e) => set("n_pax", e.target.value)}
                      className="mt-1 input-saas w-full" />
                  </label>
                </div>
              </section>

              {/* Soggiorno */}
              <section className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Soggiorno</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-medium text-slate-600 sm:col-span-2 dark:text-slate-400">
                    Hotel *
                    <input value={form.hotel} onChange={(e) => set("hotel", e.target.value)}
                      className={`mt-1 input-saas w-full ${!form.hotel ? "border-amber-300 bg-amber-50" : ""}`}
                      placeholder="Nome hotel" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Data arrivo *
                    <input value={form.data_arrivo} onChange={(e) => set("data_arrivo", e.target.value)}
                      className={`mt-1 input-saas w-full ${!form.data_arrivo ? "border-amber-300 bg-amber-50" : ""}`}
                      placeholder="Es. 19-apr-26 o 2026-04-19" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Orario arrivo
                    <input value={form.orario_arrivo} onChange={(e) => set("orario_arrivo", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="HH:MM" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Data partenza
                    <input value={form.data_partenza} onChange={(e) => set("data_partenza", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="Es. 26-apr-26 o 2026-04-26" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Orario partenza
                    <input value={form.orario_partenza} onChange={(e) => set("orario_partenza", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="HH:MM" />
                  </label>
                </div>
              </section>

              {/* Trasporto */}
              <section className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Trasporto</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-medium text-slate-600 sm:col-span-2 dark:text-slate-400">
                    Tipo servizio
                    <select value={form.tipo_servizio} onChange={(e) => set("tipo_servizio", e.target.value)} className="mt-1 input-saas w-full">
                      {Object.entries(TIPO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    N. Treno / mezzo andata
                    <input value={form.treno_andata} onChange={(e) => set("treno_andata", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="Es. 9919" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    N. Treno / mezzo ritorno
                    <input value={form.treno_ritorno} onChange={(e) => set("treno_ritorno", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="Es. 9940" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Città / stazione partenza
                    <input value={form.citta_partenza} onChange={(e) => set("citta_partenza", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="Es. Torino P. Nuova" />
                  </label>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Totale pratica (€)
                    <input type="number" min="0" step="0.01" value={form.totale_pratica} onChange={(e) => set("totale_pratica", e.target.value)}
                      className="mt-1 input-saas w-full" placeholder="Es. 104.00" />
                  </label>
                </div>
              </section>

              {/* Note */}
              <section className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2 dark:border-slate-700 dark:bg-slate-800/50">
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                  Note operative
                  <textarea rows={3} value={form.note} onChange={(e) => set("note", e.target.value)}
                    className="mt-1 input-saas w-full resize-none" placeholder="Note aggiuntive..." />
                </label>
              </section>

              {/* Salva */}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || !form.cliente_nome || !form.hotel || !form.data_arrivo}
                  className="btn-primary px-6 py-2.5 text-sm disabled:opacity-50"
                >
                  {step === "saving" ? "Salvataggio..." : "Salva servizio"}
                </button>
                <p className="text-xs text-slate-400">Il servizio apparirà subito in Arrivi e Partenze</p>
                <button type="button" onClick={reset} className="ml-auto btn-secondary px-4 py-2 text-sm">Annulla</button>
              </div>
            </div>
          )}

          {/* ── STEP: done ───────────────────────────────────────────────── */}
          {step === "done" && (
            <div className="p-5 space-y-4">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4">
                <p className="text-sm font-semibold text-emerald-800">Servizio salvato correttamente</p>
                <p className="mt-1 text-xs text-emerald-600">
                  {form.cliente_nome} · {form.hotel} · {form.data_arrivo}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <a href="/arrivals" className="btn-primary px-5 py-2 text-sm">Vai agli Arrivi</a>
                <a href="/departures" className="btn-secondary px-5 py-2 text-sm">Vai alle Partenze</a>
                <button type="button" onClick={reset} className="btn-secondary px-5 py-2 text-sm">Importa altro PDF</button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
