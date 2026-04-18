import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center">
      <p className="text-7xl font-black text-slate-200">404</p>
      <h1 className="text-xl font-bold text-slate-800">Pagina non trovata</h1>
      <p className="text-sm text-slate-500">La pagina che cerchi non esiste o è stata spostata.</p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition"
      >
        Torna alla dashboard
      </Link>
    </div>
  );
}
