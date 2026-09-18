import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import { EmergenzaCopyMessageButton, EMERGENCY_REPORT_TEMPLATE } from "@/components/emergenza-copy-button";

/**
 * Pagina interamente statica: nessun fetch, nessuna dipendenza da Supabase,
 * nessuno stato — deve restare leggibile anche se un modulo operativo ha
 * problemi. L'unica interattività (copia messaggio) vive nel componente
 * client isolato EmergenzaCopyMessageButton.
 */

type ProcedureStep = {
  number: number;
  title: string;
  content: ReactNode;
};

const PROCEDURE_STEPS: ProcedureStep[] = [
  {
    number: 1,
    title: "Controlla se è solo il tuo PC",
    content: (
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
        <li>Aggiorna la pagina</li>
        <li>Se necessario fai logout/login</li>
        <li>Apri un&apos;altra pagina di AURIS</li>
        <li>Se le altre pagine funzionano, probabilmente il problema è limitato al modulo che stavi usando</li>
      </ul>
    ),
  },
  {
    number: 2,
    title: "Chiedi a un altro operatore",
    content: (
      <div className="space-y-2 text-sm text-slate-700">
        <p className="font-semibold text-slate-800">&quot;A te AURIS funziona?&quot;</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Se agli altri funziona → possibile sessione/browser/permessi</li>
          <li>Se non funziona a nessuno → possibile problema generale</li>
        </ul>
      </div>
    ),
  },
  {
    number: 3,
    title: "Non fare tentativi ripetuti",
    content: (
      <div className="space-y-3 text-sm text-slate-700">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="font-semibold text-amber-900">NON:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-900">
            <li>premere ripetutamente lo stesso pulsante</li>
            <li>ricreare immediatamente lo stesso servizio</li>
            <li>rifare un&apos;importazione</li>
            <li>cancellare dati per provare</li>
            <li>modificare direttamente il database</li>
          </ul>
        </div>
        <p>
          <span className="font-semibold text-slate-800">Particolare attenzione a:</span> assegnazioni, bus/gruppi, import Excel/PDF,
          cancellazioni, WhatsApp/email.
        </p>
      </div>
    ),
  },
  {
    number: 4,
    title: "Raccogli le informazioni",
    content: (
      <div className="space-y-3 text-sm text-slate-700">
        <ul className="list-disc space-y-1 pl-5">
          <li>ora esatta</li>
          <li>pagina/modulo</li>
          <li>cosa stava facendo</li>
          <li>numero pratica / cliente / servizio</li>
          <li>screenshot dell&apos;errore</li>
        </ul>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-600">
          10:42
          <br />
          Prenotazioni
          <br />
          Stavo assegnando BUS 3 al gruppo Rossi
          <br />
          Pratica ITS-2026-1842
          <br />
          Premo Assegna e non succede nulla
        </div>
      </div>
    ),
  },
  {
    number: 5,
    title: "Capisci che tipo di problema è",
    content: <ProblemTypeGrid />,
  },
];

const PROBLEM_TYPES: Array<{ label: string; meaning: string; warn?: boolean }> = [
  { label: "SOLO UNA PAGINA", meaning: "problema probabilmente limitato al modulo" },
  { label: "SOLO UN UTENTE", meaning: "sessione / browser / permessi" },
  { label: "TUTTI GLI UTENTI", meaning: "possibile infrastruttura/backend" },
  { label: "UN SOLO SERVIZIO", meaning: "possibile dato incoerente" },
  { label: "SOLO WHATSAPP", meaning: "problema WhatsApp/Meta, non AURIS interamente" },
  { label: "IMPORT BLOCCATO", meaning: "NON rilanciare l'import finché non è stato verificato il primo", warn: true },
];

function ProblemTypeGrid() {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {PROBLEM_TYPES.map((item) => (
        <div
          key={item.label}
          className={`rounded-lg border p-3 text-sm ${item.warn ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}
        >
          <p className={`font-semibold ${item.warn ? "text-amber-900" : "text-slate-800"}`}>{item.label}</p>
          <p className={`mt-0.5 ${item.warn ? "text-amber-900" : "text-slate-600"}`}>→ {item.meaning}</p>
        </div>
      ))}
    </div>
  );
}

const STOP_OPERATION_REASONS: string[] = [
  "nessun operatore riesce ad accedere",
  "non si vedono i servizi del giorno",
  "non è possibile creare/modificare servizi",
  "assegnazioni vengono perse o duplicate",
  "dati di tenant diversi diventano visibili",
  "cancellazioni/import producono dati incoerenti",
  "database/backend risultano irraggiungibili",
];

const CONTINUITY_ACTIONS: string[] = [
  "annota i nuovi servizi su un foglio temporaneo",
  "annota modifiche urgenti",
  "annota assegnazioni concordate verbalmente",
  "quando AURIS torna disponibile, controlla prima che i dati non siano già presenti",
  "inserisci ogni informazione una sola volta",
];

const QUICK_LINKS: Array<{ label: string; href: string }> = [
  { label: "Apri Controllo Giornata", href: "/controllo-giornata" },
  { label: "Apri Control Room", href: "/mappa-live" },
  { label: "Apri Prenotazioni", href: "/inbox" },
  { label: "Apri Inbox WhatsApp", href: "/whatsapp" },
];

export default function EmergenzaAssistenzaPage() {
  return (
    <section className="page-section space-y-4">
      <PageHeader
        title="Emergenza / Assistenza"
        subtitle="Cosa fare nei primi 5 minuti quando qualcosa non funziona."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Emergenza / Assistenza" }]}
      />

      {/* Blocco iniziale — evidente ma non allarmistico: blu/slate = informazione. */}
      <div className="card border border-blue-200 bg-blue-50 p-4">
        <p className="text-sm font-bold uppercase tracking-wide text-blue-900">Prima regola</p>
        <p className="mt-1 text-base font-semibold text-blue-900">
          Non ripetere più volte la stessa operazione. Prima controlla cosa è successo.
        </p>
        <p className="mt-2 text-sm text-blue-800">
          Se un salvataggio, un&apos;importazione, un&apos;assegnazione o una cancellazione sembra bloccata, non ripeterla finché non è
          stato verificato il primo tentativo.
        </p>
      </div>

      {/* Procedura 5 minuti — 5 card numerate, 1 colonna (leggibilità sotto pressione). */}
      <div className="space-y-3">
        {PROCEDURE_STEPS.map((step) => (
          <div key={step.number} className="card p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
                {step.number}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-bold text-slate-900">{step.title}</h2>
                <div className="mt-2">{step.content}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quando è emergenza vera — rosso, SOLO qui. */}
      <div className="card border border-rose-300 bg-rose-50 p-4">
        <h2 className="text-base font-bold text-rose-900">Quando fermare l&apos;operazione</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-900">
          {STOP_OPERATION_REASONS.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm font-semibold text-rose-900">
          In questi casi ferma solo l&apos;operazione interessata e segnala subito il problema. Non cercare di correggere direttamente
          i dati.
        </p>
      </div>

      {/* Continuità operativa — blu/slate = informazione. */}
      <div className="card border border-slate-200 bg-slate-50 p-4">
        <h2 className="text-base font-bold text-slate-900">Continua l&apos;operatività senza perdere informazioni</h2>
        <p className="mt-1 text-sm text-slate-600">Se AURIS è temporaneamente indisponibile:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {CONTINUITY_ACTIONS.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      </div>

      {/* Messaggio pronto — template statico + pulsante client isolato. */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-base font-bold text-slate-900">Messaggio da inviare per chiedere assistenza</h2>
          <EmergenzaCopyMessageButton />
        </div>
        <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700">
          {EMERGENCY_REPORT_TEMPLATE}
        </pre>
      </div>

      {/* Link rapidi — nessuna chiamata API, solo navigazione. */}
      <div className="card p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Link rapidi</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {QUICK_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              {link.label} →
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
