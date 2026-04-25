"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setPreviewLoading(true);
      setPreviewHtml("");
      const { data: { session } } = await supabase!.auth.getSession();
      const token = session?.access_token;
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
    const { data: { session } } = await supabase!.auth.getSession();
    const token = session?.access_token;
    if (!token) { setTestResult({ ok: false, msg: "Non autenticato." }); setSending(false); return; }
    const res = await fetch("/api/admin/test-review-email", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (json.ok) {
      setTestResult({ ok: true, msg: `Email inviata a ${json.sent_to}!`, url: json.review_url });
    } else {
      setTestResult({ ok: false, msg: json.error ?? "Errore." });
    }
    setSending(false);
  }

  return (
    <section className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Anteprima template email e PDF</h1>
        <p className="text-sm text-slate-500 mt-1">Visualizza come appaiono le comunicazioni inviate da Ischia Transfer.</p>
      </div>

      {/* Test email revisione */}
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

      <div className="flex flex-wrap gap-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
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
          <p className="text-xs text-slate-500">{t.desc}</p>
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
