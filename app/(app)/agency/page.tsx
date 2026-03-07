import Link from "next/link";

export default function AgencyPage() {
  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Area Agency</h1>
      <div className="card space-y-3 p-4">
        <p className="text-sm text-slate-600">Crea una nuova prenotazione oppure controlla lo stato delle tue richieste.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/services/new" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white">
            Nuova prenotazione
          </Link>
          <Link href="/agency/bookings" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium">
            Le mie prenotazioni
          </Link>
        </div>
      </div>
    </section>
  );
}
