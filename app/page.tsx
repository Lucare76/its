import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="card w-full space-y-6 p-8 md:p-10">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Ischia Transfer Service</p>
          <h1 className="text-3xl font-semibold text-text md:text-4xl">Transfer affidabili per chi arriva a Ischia</h1>
          <p className="max-w-2xl text-sm leading-7 text-muted md:text-base">
            Servizio transfer attivo dal 2006, con esperienza nell&apos;organizzazione di transfer per chi arriva a
            Ischia e coordinamento diretto tra aeroporto, porto e hotel.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-5">
          <ul className="space-y-2 text-sm text-muted">
            <li>Servizio attivo dal 2006</li>
            <li>Coordinamento transfer aeroporto-porto-hotel</li>
            <li>Contatto diretto e risposta rapida</li>
            <li>Conoscenza del territorio</li>
          </ul>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <article className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold text-text">Accesso operativo</h2>
            <p className="mt-2 text-sm text-muted">
              Accedi all&apos;area operativa per gestire dashboard, dispatch e flussi condivisi con coordinamento diretto
              tra porto, aeroporto e hotel.
            </p>
            <div className="mt-4">
              <Link href="/login" className="btn-primary inline-flex px-4 py-2 text-sm">
                Accedi all&apos;area riservata
              </Link>
            </div>
          </article>

          <article className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold text-text">Affidabilita operativa</h2>
            <p className="mt-2 text-sm text-muted">
              Verifica rapida di ambiente, API e configurazione: un controllo tecnico utile per mantenere il servizio
              operativo e rispondere rapidamente.
            </p>
            <div className="mt-4">
              <Link href="/health" className="btn-secondary inline-flex px-4 py-2 text-sm">
                Verifica disponibilita
              </Link>
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}
