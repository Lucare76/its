"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

/* ------------------------------------------------------------------ types */

type InboundEmail = {
  id: string;
  from_email: string;
  subject: string;
  created_at: string;
  review_status: string;
  draft_service_id: string | null;
  direction: string | null;
  date: string | null;
  hotel: string | null;
  customer_name: string | null;
  pax: number | null;
  has_pdf: boolean;
  pdf_parser: { key?: string; score?: number } | null;
};

/* ------------------------------------------------------------------ helpers */

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; border: string }> = {
  needs_review: { label: "Da revisionare", bg: "#fffbeb", color: "#92400e", border: "#fde68a" },
  approved:     { label: "Approvato",      bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" },
  rejected:     { label: "Rifiutato",      bg: "#fef2f2", color: "#991b1b", border: "#fecaca" },
  imported:     { label: "Importato",      bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  unknown:      { label: "Sconosciuto",    bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("it-IT", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/* ================================================================ COMPONENT */

export default function IngestionPage() {
  const [tab, setTab] = useState<"log" | "test">("log");

  return (
    <section className="page-section">
      <PageHeader
        title="Acquisizione Email"
        subtitle="Monitoraggio email inbound e strumento di test."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Acquisizione Email" }]}
      />

      {/* tab switcher */}
      <div className="flex gap-1 border-b border-slate-200 pb-0">
        {(["log", "test"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-t-lg px-4 py-2 text-sm font-semibold transition ${
              tab === t
                ? "bg-white border border-b-white border-slate-200 -mb-px text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "log" ? "📥 Log email inbound" : "🧪 Test invio"}
          </button>
        ))}
      </div>

      {tab === "log" && <InboundLog />}
      {tab === "test" && <TestPanel />}
    </section>
  );
}

/* ============================================================== INBOUND LOG */

function InboundLog() {
  const [emails, setEmails] = useState<InboundEmail[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 30;

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    const token = await getToken();
    if (!token) { setLoading(false); setError("Sessione non disponibile."); return; }
    const res = await fetch(`/api/ops/inbound-emails?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as { ok?: boolean; emails?: InboundEmail[]; total?: number; error?: string };
    if (!body.ok) { setLoading(false); setError(body.error ?? "Errore caricamento."); return; }
    setEmails(body.emails ?? []);
    setTotal(body.total ?? 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load(page * PAGE_SIZE);
    });
    return () => {
      cancelled = true;
    };
  }, [load, page]);

  const filtered = useMemo(() =>
    filterStatus === "all" ? emails : emails.filter((e) => e.review_status === filterStatus),
    [emails, filterStatus]
  );

  const totals = useMemo(() => ({
    needs_review: emails.filter((e) => e.review_status === "needs_review").length,
    approved:     emails.filter((e) => e.review_status === "approved").length,
    imported:     emails.filter((e) => e.review_status === "imported").length,
    with_pdf:     emails.filter((e) => e.has_pdf).length,
  }), [emails]);

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Totale (pagina)",  value: emails.length },
          { label: "Da revisionare",   value: totals.needs_review },
          { label: "Approvati/Import", value: totals.approved + totals.imported },
          { label: "Con PDF",          value: totals.with_pdf },
        ].map((k) => (
          <div key={k.label} className="card p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k.label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{k.value}</p>
          </div>
        ))}
      </div>

      <SectionCard
        title={`Email inbound${total > 0 ? ` (${total} totali)` : ""}`}
        loading={loading}
        loadingLines={5}
        actions={
          <div className="flex gap-1 flex-wrap items-center">
            {["all", "needs_review", "approved", "imported", "rejected"].map((s) => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border transition ${filterStatus === s ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                {s === "all" ? "Tutte" : STATUS_CONFIG[s]?.label ?? s}
              </button>
            ))}
            <button onClick={() => void load(page * PAGE_SIZE)} className="ml-2 rounded-full px-2.5 py-1 text-[11px] font-semibold border border-slate-200 bg-white text-slate-600 hover:border-slate-400 transition">
              ↻ Aggiorna
            </button>
          </div>
        }
      >
        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 text-sm">{error}</div>
        )}

        {!loading && filtered.length === 0 && !error && (
          <p className="text-sm text-slate-400">Nessuna email inbound ricevuta.</p>
        )}

        {filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((email) => {
              const cfg = STATUS_CONFIG[email.review_status] ?? STATUS_CONFIG.unknown;
              return (
                <div key={email.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-2 shadow-sm">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-slate-900 truncate text-sm">{email.subject || "(senza oggetto)"}</p>
                        <span style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold shrink-0">
                          {cfg.label}
                        </span>
                        {email.has_pdf && (
                          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold shrink-0 bg-violet-50 text-violet-700 border border-violet-200">
                            PDF{email.pdf_parser?.key ? ` · ${email.pdf_parser.key}` : ""}
                            {email.pdf_parser?.score != null ? ` (${Math.round(email.pdf_parser.score * 100)}%)` : ""}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {email.from_email} · {fmtDate(email.created_at)}
                      </p>
                    </div>
                    <div className="text-xs text-slate-400 font-mono shrink-0">{email.id.slice(0, 8)}…</div>
                  </div>

                  {/* Dati estratti */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    {email.direction && (
                      <span>{email.direction === "arrival" ? "🛬 Arrivo" : "🛫 Partenza"}</span>
                    )}
                    {email.date && <span>📅 {email.date}</span>}
                    {email.customer_name && <span>👤 {email.customer_name}</span>}
                    {email.hotel && <span>🏨 {email.hotel}</span>}
                    {email.pax && <span>👥 {email.pax} pax</span>}
                    {email.draft_service_id && (
                      <span className="text-emerald-600">✓ Servizio bozza creato</span>
                    )}
                    {!email.draft_service_id && (
                      <span className="text-amber-600">⚠ Nessun servizio bozza</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Paginazione */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-slate-400">Pagina {page + 1} · {total} totali</span>
            <div className="flex gap-2">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition">
                ← Precedente
              </button>
              <button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition">
                Successiva →
              </button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/* ============================================================= TEST PANEL */

function TestPanel() {
  const defaultRawEmail =
    "DATA 2026-03-02 ORA 15:30 NAVE Medmar HOTEL Hotel Forio 2 PAX 3 NOME Anna Bianchi TEL +39 333 5558899";
  const [token, setToken] = useState("");
  const [mailbox, setMailbox] = useState("test-mailbox@demo.local");
  const [fromEmail, setFromEmail] = useState("agency@demo.com");
  const [subject, setSubject] = useState("Nuovo transfer - arrivo");
  const [rawEmail, setRawEmail] = useState(defaultRawEmail);
  const [attachmentsRaw, setAttachmentsRaw] = useState('[{"filename":"voucher.pdf","mime_type":"application/pdf","size_bytes":128400}]');
  const [pdfAttachmentBase64, setPdfAttachmentBase64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const curlPreview = useMemo(() => [
    "curl -X POST http://localhost:3010/api/inbound/email \\",
    `  -H "x-inbound-token: ${token || "<EMAIL_INBOUND_TOKEN>"}" \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"subject":"Nuovo transfer","from":"agency@example.com","body_text":"...","attachments":[]}\''
  ].join("\n"), [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    let attachments: Array<{ filename: string; mime_type?: string; size_bytes?: number }> = [];
    try {
      const parsed = JSON.parse(attachmentsRaw) as Array<{ filename: string; mime_type?: string; size_bytes?: number }>;
      attachments = Array.isArray(parsed) ? parsed : [];
    } catch {
      setLoading(false);
      setMessage({ type: "err", text: "JSON allegati non valido." });
      return;
    }

    if (!token.trim()) {
      setLoading(false);
      setMessage({ type: "err", text: "Inserisci EMAIL_INBOUND_TOKEN." });
      return;
    }

    const safeBodyText =
      pdfAttachmentBase64 && (rawEmail.trim().length === 0 || rawEmail.trim() === defaultRawEmail)
        ? "Dettagli nel PDF allegato. Usa extracted_text."
        : rawEmail;

    const payload = {
      subject,
      from: fromEmail,
      body_text: safeBodyText,
      body_html: "",
      attachments: attachments
        .map((item, index) => {
          const base64 = index === 0 ? pdfAttachmentBase64 : null;
          if (!base64) return null;
          return { filename: item.filename, mimetype: item.mime_type ?? "application/octet-stream", base64 };
        })
        .filter((item): item is { filename: string; mimetype: string; base64: string } => Boolean(item)),
    };

    const response = await fetch("/api/inbound/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-inbound-token": token },
      body: JSON.stringify(payload),
    });

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean; id?: string; draft_service_id?: string; error?: string;
    } | null;

    setLoading(false);
    if (!response.ok || !body?.ok) {
      setMessage({ type: "err", text: body?.error ?? `Errore HTTP ${response.status}` });
    } else {
      setMessage({ type: "ok", text: `Email salvata (id: ${body.id}). Servizio bozza: ${body.draft_service_id ?? "n/d"}.` });
    }
  };

  return (
    <div className="space-y-4">
      {message && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium border ${message.type === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-700"}`}>
          {message.type === "ok" ? "✅ " : "❌ "}{message.text}
          <button onClick={() => setMessage(null)} className="ml-3 text-current opacity-50 hover:opacity-100">✕</button>
        </div>
      )}

      <SectionCard title="Invia email inbound di test" subtitle="Simula l'arrivo di un'email dall'agenzia">
        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 md:col-span-2">
              EMAIL_INBOUND_TOKEN *
              <input value={token} onChange={(e) => setToken(e.target.value)} required placeholder="Inserisci token" className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Mailbox
              <input value={mailbox} onChange={(e) => setMailbox(e.target.value)} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Mittente (from)
              <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 md:col-span-2">
              Oggetto
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 md:col-span-2">
              Corpo email
              <textarea rows={5} value={rawEmail} onChange={(e) => setRawEmail(e.target.value)} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 md:col-span-2">
              Metadati allegati (JSON)
              <textarea rows={3} value={attachmentsRaw} onChange={(e) => setAttachmentsRaw(e.target.value)} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 md:col-span-2">
              PDF allegato (opzionale)
              <input type="file" accept="application/pdf,.pdf" className="mt-1 input-saas w-full"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) { setPdfAttachmentBase64(null); return; }
                  const reader = new FileReader();
                  reader.onload = () => {
                    const result = typeof reader.result === "string" ? reader.result : "";
                    setPdfAttachmentBase64((result.includes(",") ? result.split(",")[1] : result) || null);
                  };
                  reader.readAsDataURL(file);
                }}
              />
              <p className="mt-1 text-xs text-slate-400">{pdfAttachmentBase64 ? "PDF caricato (base64)." : "Nessun PDF allegato."}</p>
            </label>
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 disabled:opacity-50">
            {loading ? "Invio..." : "Invia email inbound di test"}
          </button>
        </form>
      </SectionCard>

      <SectionCard title="Contratto endpoint">
        <p className="text-sm text-slate-600 mb-3">
          <code className="bg-slate-100 rounded px-1 py-0.5 text-xs">POST /api/inbound/email</code> — protetto da header{" "}
          <code className="bg-slate-100 rounded px-1 py-0.5 text-xs">x-inbound-token: EMAIL_INBOUND_TOKEN</code>
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100 whitespace-pre-wrap">{curlPreview}</pre>
      </SectionCard>
    </div>
  );
}
