import Link from "next/link";

export default function AgencyPage() {
  return (
    <section className="mx-auto max-w-3xl page-section">
      <h1 className="section-title">Area Agenzia</h1>
      <div className="card space-y-3 p-4">
        <p className="text-sm text-slate-600">Crea una nuova prenotazione oppure controlla lo stato delle tue richieste.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/agency/new-booking" className="btn-primary">
            Nuova prenotazione
          </Link>
          <Link href="/agency/bookings" className="btn-secondary">
            Le mie prenotazioni
          </Link>
        </div>
      </div>
    </section>
  );
}
