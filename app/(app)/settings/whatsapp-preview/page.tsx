"use client";

import { useState } from "react";

const ITS_PHONE    = "0813331053";
const ITS_PHONE_E164 = "+390813331053";

const SAMPLE = {
  name:   "Mario Rossi",
  nameEn: "John Smith",
  date:   "20 luglio 2025",
  dateEn: "July 20, 2025",
  porto:  "Napoli Beverello",
  portoEn:"Naples (Beverello)",
  serviceId: "00000000-0000-0000-0000-000000000001",
};

type Template = {
  id: string;
  name: string;
  label: string;
  lang: "it" | "en";
  trigger: string;
  hasQr?: boolean;
  footer: string;
  btnLabel: string;
  body: string;
};

const FOOTER_IT = `Ischia Transfer Service • ${ITS_PHONE}`;
const FOOTER_EN = `Ischia Transfer Service • ${ITS_PHONE}`;

const TEMPLATES: Template[] = [
  {
    id: "aeroporto_it", name: "its_info_aeroporto", label: "Aeroporto", lang: "it",
    trigger: "Arrivo da aeroporto — prefisso +39",
    footer: FOOTER_IT, btnLabel: "Chiama assistenza",
    body: `Gentile *${SAMPLE.name}*, benvenuto! 🏝

Ecco le informazioni per il giorno del suo arrivo:

🛬 *In aeroporto*
Nella hall degli arrivi il nostro assistente la attende con il cartello *Ischia Transfer Service*.

🚢 *Trasferimento*
Il team la accompagnerà al porto per la navigazione verso Ischia.

🏝 *Allo sbarco*
A Ischia troverà nuovamente il nostro assistente con lo stesso cartello.

Ci vediamo presto!`,
  },
  {
    id: "aeroporto_en", name: "its_info_aeroporto_en", label: "Airport", lang: "en",
    trigger: "Airport arrival — non +39 prefix",
    footer: FOOTER_EN, btnLabel: "Call us",
    body: `Dear *${SAMPLE.nameEn}*, welcome! 🏝

Here is the information for your arrival day:

🛬 *At the airport*
Our assistant will be waiting for you in the arrivals hall with an *Ischia Transfer Service* sign.

🚢 *Transfer*
Our team will take you to the port for the crossing to Ischia.

🏝 *On arrival*
In Ischia, our assistant will be waiting again with the same sign.

See you soon!`,
  },
  {
    id: "stazione_it", name: "its_info_stazione", label: "Stazione", lang: "it",
    trigger: "Arrivo da stazione/treno — prefisso +39",
    footer: FOOTER_IT, btnLabel: "Chiama assistenza",
    body: `Gentile *${SAMPLE.name}*, benvenuto! 🏝

Ecco le informazioni per il giorno della sua partenza:

🚉 *In stazione*
Il nostro assistente la attende con il cartello *Ischia Transfer Service*.

🚢 *Trasferimento*
Il team la accompagnerà al porto per la navigazione verso Ischia.

🏝 *Allo sbarco*
A Ischia troverà nuovamente il nostro assistente con lo stesso cartello.

Ci vediamo presto!`,
  },
  {
    id: "stazione_en", name: "its_info_stazione_en", label: "Train Station", lang: "en",
    trigger: "Train station arrival — non +39 prefix",
    footer: FOOTER_EN, btnLabel: "Call us",
    body: `Dear *${SAMPLE.nameEn}*, welcome! 🏝

Here is the information for your departure day:

🚉 *At the station*
Our assistant will be waiting for you with an *Ischia Transfer Service* sign.

🚢 *Transfer*
Our team will take you to the port for the crossing to Ischia.

🏝 *On arrival*
In Ischia, our assistant will be waiting again with the same sign.

See you soon!`,
  },
  {
    id: "medmar_it", name: "its_info_medmar", label: "MEDMAR", lang: "it",
    trigger: "Formula MEDMAR Napoli / Pozzuoli — prefisso +39",
    footer: FOOTER_IT, btnLabel: "Chiama assistenza",
    body: `Gentile *${SAMPLE.name}*, benvenuto! 🏝

Ecco le informazioni per il suo viaggio da *${SAMPLE.porto}*:

🏝 *Allo sbarco a Ischia*
Il nostro assistente la attende con il cartello *Ischia Transfer Service*.

📱 *Giorno della partenza*
Riceverà via WhatsApp l'orario e i dettagli del trasferimento verso *${SAMPLE.porto}*.

Ci vediamo presto!`,
  },
  {
    id: "medmar_en", name: "its_info_medmar_en", label: "MEDMAR (EN)", lang: "en",
    trigger: "Formula MEDMAR — non +39 prefix",
    footer: FOOTER_EN, btnLabel: "Call us",
    body: `Dear *${SAMPLE.nameEn}*, welcome! 🏝

Here is the information for your journey from *${SAMPLE.portoEn}*:

🏝 *Upon arrival in Ischia*
Our assistant will be waiting with an *Ischia Transfer Service* sign.

📱 *On departure day*
You will receive via WhatsApp the time and details of your transfer to *${SAMPLE.portoEn}*.

See you soon!`,
  },
  {
    id: "snav_it", name: "its_info_snav", label: "SNAV", lang: "it",
    trigger: "Formula SNAV — prefisso +39",
    footer: FOOTER_IT, btnLabel: "Chiama assistenza",
    body: `Gentile *${SAMPLE.name}*, benvenuto! 🏝

Ecco le informazioni per la sua partenza con SNAV:

⛴ *Allo sbarco a Casamicciola*
Si rechi alle biglietterie SNAV.

📍 *Alle biglietterie*
Il nostro assistente la attende con il cartello *Ischia Transfer Service*.

📱 *Giorno della partenza*
Riceverà via WhatsApp i dettagli del trasferimento.

Ci vediamo presto!`,
  },
  {
    id: "snav_en", name: "its_info_snav_en", label: "SNAV (EN)", lang: "en",
    trigger: "Formula SNAV — non +39 prefix",
    footer: FOOTER_EN, btnLabel: "Call us",
    body: `Dear *${SAMPLE.nameEn}*, welcome! 🏝

Here is the information for your SNAV departure:

⛴ *Upon arrival at Casamicciola*
Please go to the SNAV ticket office.

📍 *At the ticket office*
Our assistant will be waiting with an *Ischia Transfer Service* sign.

📱 *On departure day*
You will receive via WhatsApp the transfer details.

See you soon!`,
  },
  {
    id: "bus_it", name: "its_qr_bus", label: "Bus + QR", lang: "it",
    trigger: "Servizio bus (bus_city_hotel) — prefisso +39",
    hasQr: true, footer: FOOTER_IT, btnLabel: "Chiama assistenza",
    body: `Gentile *${SAMPLE.name}*! 🏝

Ecco il suo *QR code* per accedere al servizio bus del *${SAMPLE.date}*.

✅ Mostri questo messaggio al nostro assistente al momento della salita sul mezzo.

Ci vediamo presto!`,
  },
  {
    id: "bus_en", name: "its_qr_bus_en", label: "Bus + QR (EN)", lang: "en",
    trigger: "Bus service (bus_city_hotel) — non +39 prefix",
    hasQr: true, footer: FOOTER_EN, btnLabel: "Call us",
    body: `Dear *${SAMPLE.nameEn}*! 🏝

Here is your *QR code* to access the bus service on *${SAMPLE.dateEn}*.

✅ Please show this message to our assistant when boarding.

See you soon!`,
  },
];

// ── Renderizza testo WhatsApp (bold, newline) ─────────────────────────────────
function WaText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        if (line === "") return <br key={i} />;
        const parts = line.split(/(\*[^*]+\*)/g);
        return (
          <span key={i} className="block">
            {parts.map((p, j) =>
              p.startsWith("*") && p.endsWith("*")
                ? <strong key={j}>{p.slice(1, -1)}</strong>
                : p
            )}
          </span>
        );
      })}
    </>
  );
}

// ── Bubble WhatsApp ───────────────────────────────────────────────────────────
function WaBubble({ t }: { t: Template }) {
  const appUrl = typeof window !== "undefined" ? window.location.origin : "https://app.ischiatransferservice.it";

  return (
    <div className="bg-[#e5ddd5] rounded-2xl p-4">
      <div className="flex justify-end">
        <div className="w-full max-w-[320px]">
          {/* QR header */}
          {t.hasQr && (
            <div className="rounded-t-2xl overflow-hidden bg-white shadow-sm">
              <img
                src={`${appUrl}/api/public/qr/${SAMPLE.serviceId}`}
                alt="QR Code"
                className="w-40 h-40 mx-auto block p-2"
              />
            </div>
          )}

          {/* Body */}
          <div className={`bg-white shadow-sm text-sm text-slate-800 leading-relaxed ${t.hasQr ? "rounded-b-none" : "rounded-2xl rounded-tr-none"}`}>
            <div className="px-3 pt-3 pb-1 space-y-0.5">
              <WaText text={t.body} />
            </div>

            {/* Footer */}
            <div className="px-3 pb-1">
              <p className="text-[11px] text-slate-400 mt-2">{t.footer}</p>
            </div>

            {/* Timestamp + ticks */}
            <div className="flex items-center justify-end gap-1 px-3 pb-2">
              <span className="text-[10px] text-slate-400">09:00</span>
              <svg viewBox="0 0 18 11" className="w-4 h-3 text-[#53bdeb]" fill="currentColor">
                <path d="M17.394.643a.75.75 0 0 0-1.06 1.06l1.17 1.17-7.784 7.784a.75.75 0 1 0 1.06 1.06l8.314-8.313a.75.75 0 0 0 0-1.06L17.394.643z"/>
                <path d="M11.394.643a.75.75 0 0 0-1.06 1.06l1.17 1.17-7.784 7.784a.75.75 0 1 0 1.06 1.06l8.314-8.313a.75.75 0 0 0 0-1.06L11.394.643z"/>
              </svg>
            </div>

            {/* Divider + bottone telefono */}
            <div className="border-t border-slate-100">
              <a
                href={`tel:${ITS_PHONE_E164}`}
                className="flex items-center justify-center gap-2 py-2.5 text-[#0a7cff] text-sm font-medium hover:bg-slate-50 transition rounded-b-2xl"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1C10.61 21 3 13.39 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.58a1 1 0 01-.25 1.01l-2.2 2.2z"/>
                </svg>
                {t.btnLabel}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pagina ────────────────────────────────────────────────────────────────────
export default function WhatsAppPreviewPage() {
  const [active, setActive] = useState("aeroporto_it");
  const t = TEMPLATES.find((x) => x.id === active)!;

  const groups = [
    { label: "Aeroporto",  ids: ["aeroporto_it", "aeroporto_en"] },
    { label: "Stazione",   ids: ["stazione_it",  "stazione_en"]  },
    { label: "MEDMAR",     ids: ["medmar_it",    "medmar_en"]    },
    { label: "SNAV",       ids: ["snav_it",      "snav_en"]      },
    { label: "Bus + QR",   ids: ["bus_it",       "bus_en"]       },
  ];

  return (
    <section className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Anteprima template WhatsApp</h1>
        <p className="text-sm text-slate-500 mt-1">
          Messaggi inviati automaticamente 3-6 giorni prima dell&apos;arrivo. Lingua rilevata dal prefisso telefono.
        </p>
      </div>

      {/* Selezione */}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.label} className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs font-bold text-slate-400 uppercase tracking-wide shrink-0">{g.label}</span>
            {g.ids.map((id) => {
              const tmpl = TEMPLATES.find((x) => x.id === id)!;
              return (
                <button key={id} onClick={() => setActive(id)}
                  className={`rounded-xl px-3 py-1.5 text-sm font-medium transition border ${active === id ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                  {tmpl.lang === "en" ? "🇬🇧 " : "🇮🇹 "}{tmpl.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Preview + info */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Anteprima</p>
          <div className="rounded-t-2xl bg-[#075e54] px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">ITS</div>
            <div>
              <p className="text-white font-semibold text-sm">Ischia Transfer Service</p>
              <p className="text-white/60 text-xs">Online</p>
            </div>
          </div>
          <WaBubble t={t} />
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Dettagli Meta</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Nome template</span>
                <code className="font-mono text-indigo-600 text-xs bg-indigo-50 px-1.5 py-0.5 rounded">{t.name}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Lingua</span>
                <span className="font-medium">{t.lang === "it" ? "Italiano (it)" : "English (en)"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Categoria</span>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">UTILITY</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Header</span>
                <span className="font-medium text-right">{t.hasQr ? "IMAGE (QR dinamico)" : "Nessuno"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Bottone</span>
                <span className="font-medium text-right">📞 {ITS_PHONE}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Quando viene inviato</p>
            <p className="text-sm text-slate-600">{t.trigger}</p>
            <p className="text-xs text-slate-400 mt-1">Spread automatico 3-6 giorni prima — anti-ban domenica</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Variabili</p>
            <p className="text-xs font-mono"><span className="text-indigo-600">{"{{1}}"}</span> = nome cliente</p>
            {t.id.includes("medmar") && <p className="text-xs font-mono"><span className="text-indigo-600">{"{{2}}"}</span> = porto</p>}
            {t.hasQr && <p className="text-xs font-mono"><span className="text-indigo-600">header</span> = URL QR image</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
