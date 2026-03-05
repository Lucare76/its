import Link from "next/link";

const features = [
  "Login Supabase con RBAC: admin, operator, agency, driver",
  "Dashboard servizi oggi con filtri e timeline eventi",
  "Assegnazione driver/mezzo con dispatch rapido",
  "Mappa Leaflet OSM con layer hotel e servizi",
  "Driver area mobile-first con cambi stato live",
  "Email ingestion con parser regex e conversione servizio"
];

const howItWorks = [
  "Le agenzie creano prenotazioni in pochi secondi.",
  "L'operatore assegna driver e mezzo dal dispatch.",
  "Il driver aggiorna stato in tempo reale dal telefono.",
  "La dashboard mostra KPI e criticita operative."
];

export default function LandingPage() {
  return (
    <section className="space-y-8">
      <div className="card bg-gradient-to-r from-brand-700 to-brand-500 p-8 text-white">
        <p className="text-sm uppercase tracking-[0.2em]">Beta Demo Vendibile</p>
        <h1 className="mt-2 text-4xl font-bold">Ischia Transfer</h1>
        <p className="mt-3 max-w-2xl text-white/90">
          Piattaforma multi-tenant per agenzie transfer: operativita in tempo reale, dispatch driver e ingestion
          email.
        </p>
        <div className="mt-5 flex gap-3">
          <Link href="/login" className="rounded-xl bg-white px-4 py-2 font-medium text-brand-700">
            Entra nella Demo
          </Link>
          <Link href="/dashboard" className="rounded-xl border border-white/50 px-4 py-2 font-medium">
            Vai a Dashboard
          </Link>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {features.map((feature) => (
          <article key={feature} className="card p-4 text-sm text-slate-700">
            {feature}
          </article>
        ))}
      </div>
      <section className="card p-6">
        <h2 className="text-xl font-semibold">Come funziona</h2>
        <ol className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
          {howItWorks.map((item, index) => (
            <li key={item}>
              {index + 1}. {item}
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
