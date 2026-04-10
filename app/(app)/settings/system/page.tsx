"use client";

import { useEffect, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";

type EnvVar = { key: string; label: string; group: string; present: boolean };
type CronJob = { name: string; path: string; schedule: string; description: string };
type BackupInfo = {
  last: { filename: string; date: string; size_bytes: number } | null;
  total_files: number;
  retention_days: number;
  bucket: string;
};

type SystemStatus = {
  generated_at: string;
  backup: BackupInfo;
  cron_jobs: CronJob[];
  env: EnvVar[];
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const k = String(item[key]);
    (acc[k] ??= []).push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

export default function SystemStatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const session = await getClientSessionContext();
      if (!session.accessToken) { setError("Login richiesto."); setLoading(false); return; }
      const res = await fetch("/api/admin/system-status", {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      if (!res.ok) { setError("Errore nel caricamento."); setLoading(false); return; }
      setStatus(await res.json());
      setLoading(false);
    };
    void load();
  }, []);

  if (loading) return <p className="text-sm text-slate-500 p-6">Caricamento...</p>;
  if (error || !status) return <p className="text-sm text-rose-600 p-6">{error ?? "Errore"}</p>;

  const envByGroup = groupBy(status.env, "group");
  const missingCount = status.env.filter((e) => !e.present).length;

  return (
    <section className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Stato sistema</h1>
        <p className="text-sm text-slate-500 mt-1">
          Aggiornato il {new Date(status.generated_at).toLocaleString("it-IT")}
        </p>
      </div>

      {/* Backup */}
      <div className="card p-5 space-y-4">
        <h2 className="text-base font-semibold text-slate-800">Backup automatico</h2>
        {status.backup.last ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-center">
              <p className="text-xs text-emerald-600 font-medium mb-1">Ultimo backup</p>
              <p className="text-sm font-bold text-emerald-800">{formatDate(status.backup.last.date)}</p>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-center">
              <p className="text-xs text-slate-500 font-medium mb-1">Dimensione</p>
              <p className="text-sm font-bold text-slate-700">{formatBytes(status.backup.last.size_bytes)}</p>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-center">
              <p className="text-xs text-slate-500 font-medium mb-1">File salvati</p>
              <p className="text-sm font-bold text-slate-700">{status.backup.total_files}</p>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-center">
              <p className="text-xs text-slate-500 font-medium mb-1">Retention</p>
              <p className="text-sm font-bold text-slate-700">{status.backup.retention_days} giorni</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
            Nessun backup trovato. Il primo verrà creato stanotte alle 02:00.
          </div>
        )}
        <p className="text-xs text-slate-400">Bucket: <span className="font-mono">{status.backup.bucket}</span></p>
      </div>

      {/* Cron jobs */}
      <div className="card p-5 space-y-3">
        <h2 className="text-base font-semibold text-slate-800">Cron job attivi</h2>
        <div className="divide-y divide-slate-100">
          {status.cron_jobs.map((job) => (
            <div key={job.path} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800">{job.name}</p>
                <p className="text-xs text-slate-500 mt-0.5">{job.description}</p>
                <p className="text-[11px] font-mono text-slate-400 mt-0.5">{job.path}</p>
              </div>
              <span className="shrink-0 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-mono text-slate-600">
                {job.schedule}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Variabili d'ambiente */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">Variabili d&apos;ambiente</h2>
          {missingCount > 0 ? (
            <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700">
              {missingCount} mancanti
            </span>
          ) : (
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
              Tutte presenti
            </span>
          )}
        </div>
        <div className="space-y-4">
          {Object.entries(envByGroup).map(([group, vars]) => (
            <div key={group}>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mb-2">{group}</p>
              <div className="space-y-1.5">
                {vars.map((v) => (
                  <div key={v.key} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 bg-slate-50">
                    <span className="text-sm text-slate-700">{v.label}</span>
                    {v.present ? (
                      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">✓ OK</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">✗ Mancante</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
