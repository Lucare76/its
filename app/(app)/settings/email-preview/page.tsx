"use client";

import { useEffect, useState } from "react";
import { supabase, getToken} from "@/lib/supabase/client";

const TEMPLATES = [
  { key: "quote",    label: "Preventivo cliente",       desc: "Email preventivo con accetta/rifiuta e riepilogo viaggio" },
  { key: "booking",  label: "Conferma prenotazione",   desc: "Email inviata al cliente agenzia dopo una prenotazione" },
  { key: "otp",      label: "Codice di verifica OTP",  desc: "Email con codice accesso a 6 cifre" },
  { key: "reset",    label: "Reset password",           desc: "Email con link per impostare nuova password" },
  { key: "approval", label: "Approvazione accesso",    desc: "Email inviata quando un nuovo utente viene approvato" },
  { key: "report",   label: "Riepilogo operativo",     desc: "Report arrivi/partenze inviato alle agenzie" },
  { key: "invoice",  label: "Estratto conto / PDF",    desc: "Fattura HTML con tabella servizi e totale" },
  { key: "reminder", label: "Reminder servizi",         desc: "Email riepilogo servizi imminenti inviata alle agenzie" },
];


export default function EmailPreviewPage() {
  const [active, setActive] = useState("quote");
  const [sending, setSending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string; url?: string } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  // Invio template personalizzato
  const [sendTo, setSendTo] = useState("");
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setPreviewLoading(true);
      setPreviewHtml("");
      const token = await getToken();
      if (!token) { setPreviewHtml("<p style='padding:24px;color:red;'>Sessione scaduta — rieffettua il login.</p>"); setPreviewLoading(false); return; }
      const res = await fetch(`/api/admin/email-preview?template=${active}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const html = await res.text();
      if (!cancelled) { setPreviewHtml(html); setPreviewLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [active]);

  async function sendTestEmail() {
    setSending(true);
    setTestResult(null);
    const token = await getToken();
    if (!token) { setTestResult({ ok: false, msg: "Non autenticato." }); setSending(false); return; }
    const res = await fetch("/api/admin/test-review-email", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    setSending(false);
    if (json.ok) {
      setTestResult({ ok: true, msg: `Email inviata a ${json.sent_to}!`, url: json.review_url });
    } else {
      setTestResult({ ok: false, msg: json.error ?? "Errore." });
    }
  }

  async function sendCurrentTemplate() {
    const emails = sendTo.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
    if (!emails.length) { setSendResult({ ok: false, msg: "Inserisci almeno un indirizzo email." }); return; }
    setSendingTemplate(true);
    setSendResult(null);
    const token = await getToken();
    if (!token) { setSendResult({ ok: false, msg: "Non autenticato." }); setSendingTemplate(false); return; }
    const res = await fetch("/api/admin/email-preview", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: emails, templates: [active] }),
    });
    const json = await res.json();
    setSendingTemplate(false);
    if (json.ok) {
      const sent = (json.results as Array<{ status: string }>).filter(r => r.status === "sent").length;
      setSendResult({ ok: true, msg: `Template "${TEMPLATES.find(t => t.key === active)?.label}" inviato a ${emails.join(", ")} (${sent} inviati).` });
    } else {
      setSendResult({ ok: false, msg: json.error ?? "Errore invio." });
    }
  }

  return (
    <section className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Anteprima template email e PDF</h1>
        <p className="text-sm text-slate-500 mt-1">Visualizza come appaiono le comunicazioni inviate da Ischia Transfer.</p>
      </div>

      {/* Test workflow revisione */}
      <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex-1">
          <div className="text-sm font-semibold text-amber-900">Test workflow revisione agenzia</div>
          <div className="text-xs text-amber-700 mt-0.5">Invia un riepilogo fittizio (10 maggio) a rennasday@gmail.com con i bottoni Approva/Modifica.</div>
          {testResult && (
            <div className={`mt-2 text-xs font-medium ${testResult.ok ? "text-green-700" : "text-red-700"}`}>
              {testResult.ok ? "✅ " : "❌ "}{testResult.msg}
              {testResult.url && (
                <> — <a href={testResult.url} target="_blank" rel="noreferrer" className="underline">Apri link revisione →</a></>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={sendTestEmail}
          disabled={sending}
          className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-60 transition-colors"
        >
          {sending ? "Invio..." : "📧 Invia test"}
        </button>
      </div>

      {/* Template tabs */}
      <div className="flex flex-wrap gap-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setActive(t.key); setSendResult(null); }}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
              active === t.key
                ? "bg-slate-900 text-white shadow"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {TEMPLATES.filter((t) => t.key === active).map((t) => (
        <div key={t.key} className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-slate-500">{t.desc}</p>
          </div>

          {/* Invio a indirizzi personalizzati */}
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <span className="text-xs text-slate-500 shrink-0">Invia a:</span>
            <input
              type="text"
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              placeholder="email1@example.com, email2@example.com"
              className="flex-1 bg-transparent text-sm outline-none text-slate-800 placeholder:text-slate-400 min-w-0"
            />
            <button
              type="button"
              onClick={sendCurrentTemplate}
              disabled={sendingTemplate || !sendTo.trim()}
              className="shrink-0 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-40 transition"
            >
              {sendingTemplate ? "Invio..." : "📤 Invia"}
            </button>
          </div>
          {sendResult && (
            <p className={`text-xs font-medium ${sendResult.ok ? "text-green-700" : "text-red-600"}`}>
              {sendResult.ok ? "✅ " : "❌ "}{sendResult.msg}
            </p>
          )}

          <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
            {previewLoading ? (
              <div className="flex items-center justify-center" style={{ height: "680px" }}>
                <p className="text-sm text-slate-400">Caricamento anteprima...</p>
              </div>
            ) : (
              <iframe
                srcDoc={previewHtml}
                className="w-full"
                style={{ height: "680px", border: "none" }}
                title={t.label}
                sandbox="allow-same-origin"
              />
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
