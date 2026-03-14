import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="card w-full space-y-6 p-8 md:p-10">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Ischia Transfer Beta</p>
          <h1 className="text-3xl font-semibold text-text md:text-4xl">Gestionale operativo</h1>
          <p className="max-w-2xl text-sm leading-7 text-muted md:text-base">
            Questo progetto e focalizzato sul gestionale interno: accesso utenti, dashboard, dispatch, area agenzia,
            import PDF, pricing e flussi operativi su Supabase.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <article className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold text-text">Accesso</h2>
            <p className="mt-2 text-sm text-muted">
              Entra con credenziali Supabase reali per usare dashboard, dispatch, area agenzia e moduli operativi.
            </p>
            <div className="mt-4">
              <Link href="/login" className="btn-primary inline-flex px-4 py-2 text-sm">
                Vai al login
              </Link>
            </div>
          </article>

          <article className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold text-text">Controllo tecnico</h2>
            <p className="mt-2 text-sm text-muted">
              La pagina health consente una verifica rapida di ambiente, API e configurazione server/client.
            </p>
            <div className="mt-4">
              <Link href="/health" className="btn-secondary inline-flex px-4 py-2 text-sm">
                Apri health
              </Link>
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}
