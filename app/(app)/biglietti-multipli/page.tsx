"use client";

import { useEffect, useRef, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Agency = { id: string; name: string; email: string | null };

type CardState = {
  files: File[];
  sending: boolean;
  result: { ok: boolean; message: string } | null;
};

const AGENCY_NAMES = ["Aleste Viaggi", "Sosandra", "Zigolo", "Angelino"];

function AgencyCard({ agency, token }: { agency: Agency; token: string }) {
  const [state, setState] = useState<CardState>({ files: [], sending: false, result: null });
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (newFiles: FileList | null) => {
    if (!newFiles) return;
    const pdfs = Array.from(newFiles).filter((f) => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    setState((prev) => {
      const combined = [...prev.files, ...pdfs].slice(0, 10);
      return { ...prev, files: combined, result: null };
    });
  };

  const removeFile = (idx: number) => {
    setState((prev) => ({ ...prev, files: prev.files.filter((_, i) => i !== idx), result: null }));
  };

  const send = async () => {
    if (state.files.length === 0 || !agency.email) return;
    setState((prev) => ({ ...prev, sending: true, result: null }));

    const fd = new FormData();
    fd.append("agency_id", agency.id);
    state.files.forEach((f) => fd.append("files", f));

    try {
      const res = await fetch("/api/biglietti/send-bulk", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; files?: number } | null;
      if (!res.ok || !body?.ok) {
        setState((prev) => ({ ...prev, sending: false, result: { ok: false, message: body?.error ?? "Invio fallito." } }));
      } else {
        setState({ files: [], sending: false, result: { ok: true, message: `${body.files} ${body.files === 1 ? "file inviato" : "file inviati"} a ${agency.email}` } });
      }
    } catch (err) {
      setState((prev) => ({ ...prev, sending: false, result: { ok: false, message: err instanceof Error ? err.message : "Errore di rete." } }));
    }
  };

  return (
    <div className="card flex flex-col gap-4 p-5">
      {/* Intestazione */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-base font-bold text-slate-900">{agency.name}</p>
          {agency.email
            ? <p className="text-xs text-slate-500 mt-0.5">{agency.email}</p>
            : <p className="text-xs text-rose-500 mt-0.5 font-medium">⚠️ Email non configurata</p>}
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${agency.email ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-600"}`}>
          {agency.email ? "Pronta" : "Email mancante"}
        </span>
      </div>

      {/* Area upload */}
      <div
        className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center cursor-pointer hover:border-blue-300 hover:bg-blue-50 transition-colors"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
      >
        <p className="text-sm text-slate-600">Trascina PDF qui o <span className="text-blue-600 font-medium">clicca per selezionare</span></p>
        <p className="text-xs text-slate-400 mt-1">Massimo 10 file PDF · {state.files.length}/10</p>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {/* Lista file */}
      {state.files.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
          {state.files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="text-slate-400">📄</span>
              <span className="flex-1 truncate text-slate-700">{f.name}</span>
              <span className="text-slate-400 shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
              <button type="button" onClick={() => removeFile(i)} className="text-slate-300 hover:text-rose-500 shrink-0">✕</button>
            </li>
          ))}
        </ul>
      )}

      {/* Feedback */}
      {state.result && (
        <div className={`rounded-xl px-3 py-2.5 text-sm font-medium ${state.result.ok ? "border border-emerald-200 bg-emerald-50 text-emerald-800" : "border border-rose-200 bg-rose-50 text-rose-700"}`}>
          {state.result.ok ? "✅ " : "❌ "}{state.result.message}
        </div>
      )}

      {/* Bottone invio */}
      <button
        type="button"
        onClick={() => void send()}
        disabled={state.sending || state.files.length === 0 || !agency.email}
        className="btn-primary w-full py-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {state.sending ? "Invio in corso..." : `Invia ${state.files.length > 0 ? `${state.files.length} ` : ""}${state.files.length === 1 ? "file" : "file"}`}
      </button>
    </div>
  );
}

export default function BigliettiMultipliPage() {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setError("Supabase non configurato.");
        setLoading(false);
        return;
      }
      const { data: session } = await supabase.auth.getSession();
      const tok = session.session?.access_token ?? null;
      if (!tok) { setError("Sessione non valida."); setLoading(false); return; }
      if (active) setToken(tok);

      // Fetch agenzie per nome
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError("Sessione non valida."); setLoading(false); return; }

      const { data: tenantData } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const tenantId = tenantData?.tenant_id;
      if (!tenantId) { setError("Tenant non trovato."); setLoading(false); return; }

      const { data: rows } = await supabase
        .from("agencies")
        .select("id, name, email")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .in("name", AGENCY_NAMES)
        .order("name");

      if (!active) return;

      // Assicura che tutte e 4 le agenzie compaiano (anche se non trovate nel DB)
      const found = (rows ?? []) as Agency[];
      const result: Agency[] = AGENCY_NAMES.map((n) => {
        const match = found.find((a) => a.name === n);
        return match ?? { id: `missing-${n}`, name: n, email: null };
      });

      setAgencies(result);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, []);

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento agenzie...</div>;
  if (error) return <div className="card p-4 text-sm text-rose-600">{error}</div>;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Invio Multiplo Biglietti</h1>
        <p className="mt-1 text-sm text-slate-500">Carica fino a 10 PDF per agenzia e invia tutti con un click.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-2">
        {agencies.map((agency) => (
          token
            ? <AgencyCard key={agency.id} agency={agency} token={token} />
            : <div key={agency.id} className="card p-4 text-sm text-slate-400">Sessione non disponibile</div>
        ))}
      </div>
    </section>
  );
}
