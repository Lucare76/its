"use client";

import { useState } from "react";

const TEMPLATES = [
  { key: "booking",  label: "Conferma prenotazione",   desc: "Email inviata al cliente agenzia dopo una prenotazione" },
  { key: "otp",      label: "Codice di verifica OTP",  desc: "Email con codice accesso a 6 cifre" },
  { key: "reset",    label: "Reset password",           desc: "Email con link per impostare nuova password" },
  { key: "approval", label: "Approvazione accesso",    desc: "Email inviata quando un nuovo utente viene approvato" },
  { key: "report",   label: "Riepilogo operativo",     desc: "Report arrivi/partenze inviato alle agenzie" },
  { key: "invoice",  label: "Estratto conto / PDF",    desc: "Fattura HTML con tabella servizi e totale" },
];

export default function EmailPreviewPage() {
  const [active, setActive] = useState("booking");

  return (
    <section className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Anteprima template email e PDF</h1>
        <p className="text-sm text-slate-500 mt-1">Visualizza come appaiono le comunicazioni inviate da Ischia Transfer.</p>
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
            <iframe
              src={`/api/admin/email-preview?template=${t.key}`}
              className="w-full"
              style={{ height: "680px", border: "none" }}
              title={t.label}
            />
          </div>
          <div className="flex justify-end">
            <a
              href={`/api/admin/email-preview?template=${t.key}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Apri in nuova scheda →
            </a>
          </div>
        </div>
      ))}
    </section>
  );
}
