"use client";

import { useState } from "react";

// ── Dati di esempio ───────────────────────────────────────────────────────────
const SAMPLE = {
  customerName:  "Mario Rossi",
  customerNameEn:"John Smith",
  date:          "20 luglio 2025",
  dateEn:        "July 20, 2025",
  portoIT:       "Napoli Beverello",
  portoEN:       "Naples (Beverello)",
  serviceId:     "00000000-0000-0000-0000-000000000001",
};

// ── Definizione template ──────────────────────────────────────────────────────
type Template = {
  id: string;
  name: string;
  label: string;
  lang: "it" | "en";
  trigger: string;
  hasQr?: boolean;
  lines: string[];
};

const TEMPLATES: Template[] = [
  {
    id: "aeroporto_it", name: "its_info_aeroporto", label: "Aeroporto", lang: "it",
    trigger: "Arrivo da aeroporto (prefisso +39)",
    lines: [
      `Gentile ${SAMPLE.customerName},`,
      "",
      "in vista del suo arrivo, ecco le informazioni per il ritiro:",
      "",
      "1. Nella hall degli arrivi in aeroporto troverà il nostro assistente con il cartello *Ischia Transfer Service*.",
      "",
      "2. Il nostro team la accompagnerà al porto di imbarco per la navigazione verso Ischia.",
      "",
      "3. Allo sbarco a Ischia, il nostro assistente la attenderà con lo stesso cartello.",
      "",
      "Per qualsiasi necessità siamo a sua disposizione.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "aeroporto_en", name: "its_info_aeroporto_en", label: "Airport", lang: "en",
    trigger: "Airport arrival (non +39 prefix)",
    lines: [
      `Dear ${SAMPLE.customerNameEn},`,
      "",
      "here is the information for your arrival at the airport:",
      "",
      "1. In the arrivals hall, our assistant will be waiting for you with an *Ischia Transfer Service* sign.",
      "",
      "2. Our team will transfer you to the port for the crossing to Ischia.",
      "",
      "3. Upon arrival in Ischia, our assistant will be waiting for you with the same sign.",
      "",
      "We are at your disposal for any questions.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "stazione_it", name: "its_info_stazione", label: "Stazione", lang: "it",
    trigger: "Arrivo da stazione/treno (prefisso +39)",
    lines: [
      `Gentile ${SAMPLE.customerName},`,
      "",
      "in vista della sua partenza, ecco le informazioni per il ritiro in stazione:",
      "",
      "1. Alla stazione troverà il nostro assistente con il cartello *Ischia Transfer Service*.",
      "",
      "2. Il nostro team la accompagnerà al porto di imbarco per la navigazione verso Ischia.",
      "",
      "3. Allo sbarco a Ischia, il nostro assistente la attenderà con lo stesso cartello.",
      "",
      "Per qualsiasi necessità siamo a sua disposizione.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "stazione_en", name: "its_info_stazione_en", label: "Train Station", lang: "en",
    trigger: "Train station arrival (non +39 prefix)",
    lines: [
      `Dear ${SAMPLE.customerNameEn},`,
      "",
      "here is the information for your departure from the train station:",
      "",
      "1. At the station, our assistant will be waiting for you with an *Ischia Transfer Service* sign.",
      "",
      "2. Our team will transfer you to the port for the crossing to Ischia.",
      "",
      "3. Upon arrival in Ischia, our assistant will be waiting for you with the same sign.",
      "",
      "We are at your disposal for any questions.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "medmar_it", name: "its_info_medmar", label: "MEDMAR", lang: "it",
    trigger: "Formula MEDMAR Napoli / Pozzuoli (prefisso +39)",
    lines: [
      `Gentile ${SAMPLE.customerName},`,
      "",
      `in vista della sua partenza da *${SAMPLE.portoIT}*, ecco le informazioni utili:`,
      "",
      "1. Allo sbarco a Ischia troverà il nostro assistente con il cartello *Ischia Transfer Service*.",
      "",
      `2. Il giorno della partenza da Ischia riceverà via WhatsApp l'orario e i dettagli del trasferimento verso *${SAMPLE.portoIT}*.`,
      "",
      "Per qualsiasi necessità siamo a sua disposizione.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "medmar_en", name: "its_info_medmar_en", label: "MEDMAR (EN)", lang: "en",
    trigger: "Formula MEDMAR — non +39 prefix",
    lines: [
      `Dear ${SAMPLE.customerNameEn},`,
      "",
      `here is the information for your departure from *${SAMPLE.portoEN}*:`,
      "",
      "1. Upon arrival in Ischia, our assistant will be waiting for you with an *Ischia Transfer Service* sign.",
      "",
      `2. On the day of your departure from Ischia, you will receive via WhatsApp the time and details of the transfer to *${SAMPLE.portoEN}*.`,
      "",
      "We are at your disposal for any questions.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "snav_it", name: "its_info_snav", label: "SNAV", lang: "it",
    trigger: "Formula SNAV (prefisso +39)",
    lines: [
      `Gentile ${SAMPLE.customerName},`,
      "",
      "in vista della sua partenza con SNAV, ecco le informazioni utili:",
      "",
      "1. Allo sbarco a Casamicciola si rechi presso le biglietterie SNAV.",
      "",
      "2. Alle biglietterie troverà il nostro assistente con il cartello *Ischia Transfer Service*.",
      "",
      "3. Il giorno della partenza da Ischia riceverà via WhatsApp l'orario e i dettagli del trasferimento.",
      "",
      "Per qualsiasi necessità siamo a sua disposizione.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "snav_en", name: "its_info_snav_en", label: "SNAV (EN)", lang: "en",
    trigger: "Formula SNAV — non +39 prefix",
    lines: [
      `Dear ${SAMPLE.customerNameEn},`,
      "",
      "here is the information for your SNAV departure:",
      "",
      "1. Upon arrival at Casamicciola, please go to the SNAV ticket office.",
      "",
      "2. At the SNAV ticket office, our assistant will be waiting for you with an *Ischia Transfer Service* sign.",
      "",
      "3. On the day of your departure from Ischia, you will receive via WhatsApp the time and details of the transfer.",
      "",
      "We are at your disposal for any questions.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "bus_it", name: "its_qr_bus", label: "Bus + QR", lang: "it",
    trigger: "Servizio bus (bus_city_hotel) — prefisso +39",
    hasQr: true,
    lines: [
      `Gentile ${SAMPLE.customerName},`,
      "",
      `ecco il suo QR code per accedere al servizio bus del *${SAMPLE.date}*.`,
      "",
      "Lo mostri all'assistente al momento della salita sul mezzo.",
      "",
      "Per qualsiasi necessità siamo a sua disposizione.",
      "*Ischia Transfer Service*",
    ],
  },
  {
    id: "bus_en", name: "its_qr_bus_en", label: "Bus + QR (EN)", lang: "en",
    trigger: "Bus service (bus_city_hotel) — non +39 prefix",
    hasQr: true,
    lines: [
      `Dear ${SAMPLE.customerNameEn},`,
      "",
      `here is your QR code to access the bus service on *${SAMPLE.dateEn}*.`,
      "",
      "Please show it to our assistant when boarding.",
      "",
      "We are at your disposal for any questions.",
      "*Ischia Transfer Service*",
    ],
  },
];

// ── Componente bubble WhatsApp ────────────────────────────────────────────────
function WaBubble({ template }: { template: Template }) {
  const appUrl = typeof window !== "undefined"
    ? window.location.origin
    : "https://app.ischiatransferservice.it";

  return (
    <div className="bg-[#e5ddd5] rounded-2xl p-4 min-h-[200px]">
      {/* Sfondo chat */}
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-1">
          {/* Header QR image */}
          {template.hasQr && (
            <div className="rounded-t-2xl rounded-bl-2xl overflow-hidden bg-white">
              <img
                src={`${appUrl}/api/public/qr/${SAMPLE.serviceId}`}
                alt="QR Code"
                className="w-full max-w-[240px] mx-auto block p-3"
              />
            </div>
          )}

          {/* Body bubble */}
          <div className={`bg-white px-3 py-2 shadow-sm text-sm text-slate-800 leading-relaxed ${template.hasQr ? "rounded-b-2xl rounded-tl-2xl" : "rounded-2xl rounded-tr-none"}`}>
            {template.lines.map((line, i) => {
              if (line === "") return <div key={i} className="h-2" />;
              // Bold text wrapped in *...*
              const parts = line.split(/(\*[^*]+\*)/g);
              return (
                <p key={i} className="break-words">
                  {parts.map((part, j) =>
                    part.startsWith("*") && part.endsWith("*")
                      ? <strong key={j}>{part.slice(1, -1)}</strong>
                      : part
                  )}
                </p>
              );
            })}
            {/* Timestamp e spunte */}
            <div className="flex items-center justify-end gap-1 mt-1">
              <span className="text-[10px] text-slate-400">09:00</span>
              <svg viewBox="0 0 16 11" className="w-4 h-3 text-[#53bdeb]" fill="currentColor">
                <path d="M11.071.653a.75.75 0 0 0-1.06 1.06L11.829 3.53l-6.9 6.9a.75.75 0 1 0 1.06 1.06l7.43-7.43a.75.75 0 0 0 0-1.06L11.072.653z"/>
                <path d="M5.071.653a.75.75 0 0 0-1.06 1.06L5.829 3.53.293 9.065a.75.75 0 1 0 1.06 1.061l6.007-6.007a.75.75 0 0 0 0-1.06L5.071.653z"/>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────
export default function WhatsAppPreviewPage() {
  const [active, setActive] = useState("aeroporto_it");

  const template = TEMPLATES.find((t) => t.id === active)!;

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
          Visualizza come appaiono i messaggi inviati automaticamente ai clienti 3 giorni prima dell&apos;arrivo.
        </p>
      </div>

      {/* Selezione template */}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.label} className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs font-bold text-slate-400 uppercase tracking-wide">{g.label}</span>
            {g.ids.map((id) => {
              const t = TEMPLATES.find((x) => x.id === id)!;
              return (
                <button
                  key={id}
                  onClick={() => setActive(id)}
                  className={`rounded-xl px-3 py-1.5 text-sm font-medium transition border ${
                    active === id
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {t.lang === "en" ? "🇬🇧 " : "🇮🇹 "}{t.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Preview */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {/* Bubble */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Anteprima messaggio</p>
          {/* Finto header WhatsApp */}
          <div className="rounded-t-2xl bg-[#075e54] px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">ITS</div>
            <div>
              <p className="text-white font-semibold text-sm">Ischia Transfer Service</p>
              <p className="text-white/70 text-xs">Online</p>
            </div>
          </div>
          <WaBubble template={template} />
        </div>

        {/* Info tecnica */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Dettagli template</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Nome Meta</span>
                <code className="font-mono text-indigo-600 text-xs bg-indigo-50 px-1.5 py-0.5 rounded">{template.name}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Lingua</span>
                <span className="font-medium">{template.lang === "it" ? "Italiano (it)" : "English (en)"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Categoria</span>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">UTILITY</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Header</span>
                <span className="font-medium">{template.hasQr ? "IMAGE (QR code)" : "Nessuno"}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Quando viene inviato</p>
            <p className="text-sm text-slate-600">{template.trigger}</p>
            <p className="text-xs text-slate-400">Invio automatico 3-6 giorni prima dell&apos;arrivo (spread anti-ban)</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Variabili</p>
            <div className="space-y-1 text-xs font-mono">
              <p><span className="text-indigo-600">{"{{1}}"}</span> = nome cliente</p>
              {template.id.includes("medmar") && (
                <p><span className="text-indigo-600">{"{{2}}"}</span> = porto (Napoli Beverello / Pozzuoli)</p>
              )}
              {template.hasQr && (
                <p><span className="text-indigo-600">header</span> = URL immagine QR</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
