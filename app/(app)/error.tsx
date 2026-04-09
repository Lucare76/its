"use client";

import { useEffect } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[AppError]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-3xl">⚠️</div>
      <h2 className="text-xl font-bold text-slate-800">Qualcosa è andato storto</h2>
      <p className="mt-2 max-w-sm text-sm text-slate-500">
        Si è verificato un errore imprevisto. Puoi riprovare oppure tornare alla dashboard.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-xs text-slate-400">Codice: {error.digest}</p>
      )}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Riprova
        </button>
        <a
          href="/dashboard"
          className="rounded-xl border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          Vai alla dashboard
        </a>
      </div>
    </div>
  );
}
