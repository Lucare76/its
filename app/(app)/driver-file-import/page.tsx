"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { DateInput, EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

type ImportResponse = {
  ok?: boolean;
  dry_run?: boolean;
  summary?: {
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
    imported_rows?: number;
  };
  preview?: Array<{
    row_index: number;
    time: string;
    direction: "arrival" | "departure";
    service_type_label: string;
    billing_party_name: string;
    hotel_name: string;
    meeting_point: string;
    pax: number;
    transport_code: string;
    notes: string;
  }>;
  errors: Array<{ row_index: number; message: string }>;
  error?: string;
};

type DriverProfile = {
  id: string;
  full_name: string;
  phone?: string | null;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDriverName(value?: string | null) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export default function DriverFileImportPage() {
  const { data, loading } = useTenantOperationalData();
  const appDrivers = useMemo(
    () => data.memberships.filter((member) => member.role === "driver").sort((left, right) => left.full_name.localeCompare(right.full_name, "it")),
    [data.memberships]
  );

  const [serviceDate, setServiceDate] = useState(todayIso());
  const [driverProfiles, setDriverProfiles] = useState<DriverProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [driverProfileId, setDriverProfileId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("Carica il file autista, scegli data e autista, poi esegui la simulazione o l'import diretto.");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const safeSummary = result?.summary ?? {
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    imported_rows: 0
  };
  const safeErrors = result?.errors ?? [];
  const safePreview = result?.preview ?? [];

  useEffect(() => {
    let active = true;

    const loadDriverProfiles = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setProfilesLoading(false);
        return;
      }

      try {
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;
        if (!token) {
          setProfilesLoading(false);
          return;
        }

        const response = await fetch("/api/ops/vehicles", {
          headers: { Authorization: `Bearer ${token}` }
        });
        const body = (await response.json().catch(() => null)) as { ok?: boolean; drivers?: DriverProfile[] } | null;
        if (!active) return;
        setDriverProfiles((body?.drivers ?? []).sort((left, right) => left.full_name.localeCompare(right.full_name, "it")));
      } finally {
        if (active) setProfilesLoading(false);
      }
    };

    void loadDriverProfiles();
    return () => {
      active = false;
    };
  }, []);

  const selectedDriverProfile = useMemo(
    () => driverProfiles.find((driver) => driver.id === driverProfileId) ?? null,
    [driverProfiles, driverProfileId]
  );

  const matchedAppDriver = useMemo(
    () => appDrivers.find((driver) => normalizeDriverName(driver.full_name) === normalizeDriverName(selectedDriverProfile?.full_name)) ?? null,
    [appDrivers, selectedDriverProfile]
  );

  const resolvedDriverUserId = matchedAppDriver?.user_id ?? "";
  const actionDisabledReason = useMemo(() => {
    if (submitting) return "Elaborazione in corso.";
    if (!file) return "Seleziona un file Excel.";
    if (!serviceDate) return "Inserisci la data del servizio.";
    if (!driverProfileId) return "Seleziona un autista.";
    if (!resolvedDriverUserId) return "L'autista selezionato non e collegato all'app driver.";
    return "";
  }, [driverProfileId, file, resolvedDriverUserId, serviceDate, submitting]);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setResult(null);
  };

  const runImport = async (dryRun: boolean) => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }
    if (!file) {
      setMessage("Seleziona prima un file Excel.");
      return;
    }
    if (!serviceDate) {
      setMessage("Inserisci la data del servizio.");
      return;
    }
    if (!driverProfileId) {
      setMessage("Seleziona l'autista destinatario.");
      return;
    }
    if (!resolvedDriverUserId) {
      setMessage("L'autista selezionato non e collegato a un account app driver.");
      return;
    }

    setSubmitting(true);
    setResult(null);
    setMessage(dryRun ? "Simulazione in corso..." : "Import in corso...");
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) {
        setMessage("Sessione non valida. Rifai login.");
        setSubmitting(false);
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("service_date", serviceDate);
      formData.append("driver_user_id", resolvedDriverUserId);
      formData.append("dry_run", dryRun ? "true" : "false");

      const response = await fetch("/api/ops/driver-file-import", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      const body = (await response.json().catch(() => null)) as ImportResponse | null;
      if (!response.ok) {
        setMessage(body?.error ?? "Import file autista non riuscito.");
        setResult(body ?? { errors: [] });
        setSubmitting(false);
        return;
      }

      setResult(body ?? { errors: [] });
      const importedRows = body?.summary?.imported_rows ?? 0;
      setMessage(
        dryRun
          ? `Simulazione completata. Valide: ${body?.summary?.valid_rows ?? 0}, errori: ${body?.summary?.invalid_rows ?? 0}.`
          : importedRows > 0
            ? `Import completato. Servizi scritti: ${importedRows}.`
            : "Import concluso senza scrivere servizi."
      );
    } catch {
      setMessage("Errore rete durante import file autista.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Import File Autista"
        subtitle="Carica un file operativo autista, scegli data e autista, poi importa i servizi gia assegnati."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Import file autista" }]}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <SectionCard title="File">
          <p className="text-sm font-semibold text-text">{file?.name ?? "Nessun file selezionato"}</p>
          <p className="mt-1 text-xs text-muted">{message}</p>
        </SectionCard>
        <SectionCard title="Data servizio">
          <DateInput value={serviceDate} onChange={setServiceDate} className="input-saas w-full" />
        </SectionCard>
        <SectionCard title="Autista">
          <select className="input-saas w-full" value={driverProfileId} onChange={(event) => setDriverProfileId(event.target.value)} disabled={loading || profilesLoading}>
            <option value="">Seleziona autista</option>
            {driverProfiles.map((driver) => (
              <option key={driver.id} value={driver.id}>{driver.full_name}{driver.phone ? ` - ${driver.phone}` : ""}</option>
            ))}
          </select>
          {selectedDriverProfile ? (
            <p className="mt-2 text-xs text-muted">
              Lista autisti: {selectedDriverProfile.full_name}{selectedDriverProfile.phone ? ` (${selectedDriverProfile.phone})` : ""}
            </p>
          ) : null}
          {selectedDriverProfile && matchedAppDriver ? (
            <p className="mt-1 text-xs text-emerald-700">Assegnazione app diretta a {matchedAppDriver.full_name}</p>
          ) : null}
          {selectedDriverProfile && !matchedAppDriver ? (
            <p className="mt-1 text-xs text-amber-700">Autista presente in elenco, ma senza account app driver collegato.</p>
          ) : null}
        </SectionCard>
        <SectionCard title="Azioni">
          <div className="flex flex-col gap-2">
            <input type="file" accept=".xlsx,.xls,.csv" className="input-saas" onChange={handleFile} />
            <button type="button" className="btn-secondary" disabled={submitting || !file || !driverProfileId || !resolvedDriverUserId || !serviceDate} onClick={() => void runImport(true)}>
              {submitting ? "Elaborazione..." : "Simula import"}
            </button>
            <button type="button" className="btn-primary" disabled={submitting || !file || !driverProfileId || !resolvedDriverUserId || !serviceDate} onClick={() => void runImport(false)}>
              {submitting ? "Import in corso..." : "Importa e assegna"}
            </button>
            <p className="text-xs text-muted">{actionDisabledReason || "Pronto per la simulazione o l'import."}</p>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Risultato" subtitle="La simulazione mostra cosa verra importato e gli eventuali errori bloccanti.">
        {!result ? (
          <EmptyState title="Nessuna simulazione eseguita" description="Carica il file e lancia la simulazione per vedere l'anteprima." compact />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Righe totali</p>
                <p className="mt-2 text-2xl font-semibold text-text">{safeSummary.total_rows}</p>
              </article>
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Valide</p>
                <p className="mt-2 text-2xl font-semibold text-text">{safeSummary.valid_rows}</p>
              </article>
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Errate</p>
                <p className="mt-2 text-2xl font-semibold text-text">{safeSummary.invalid_rows}</p>
              </article>
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Importate</p>
                <p className="mt-2 text-2xl font-semibold text-text">{safeSummary.imported_rows ?? 0}</p>
              </article>
            </div>

            {!safePreview || safePreview.length === 0 ? (
              <EmptyState title="Nessuna riga valida" description="Controlla gli errori sotto e il formato del file." compact />
            ) : (
              <div className="space-y-3">
                {safePreview.map((row) => (
                  <article key={`${row.row_index}-${row.time}-${row.hotel_name}`} className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-text">Riga {row.row_index} — {row.hotel_name}</p>
                        <p className="text-xs text-muted">{serviceDate} {row.time} · {row.direction} · {row.service_type_label}</p>
                      </div>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">{row.pax} pax</span>
                    </div>
                    <div className="mt-3 grid gap-3 text-sm text-slate-700 md:grid-cols-2 xl:grid-cols-4">
                      <p><span className="font-medium">Agenzia:</span> {row.billing_party_name || "—"}</p>
                      <p><span className="font-medium">Meeting point:</span> {row.meeting_point || "—"}</p>
                      <p><span className="font-medium">Rif. mezzo:</span> {row.transport_code || "—"}</p>
                      <p><span className="font-medium">Note:</span> {row.notes || "—"}</p>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {safeErrors.length > 0 ? (
              <div className="space-y-2">
                {safeErrors.map((item, index) => (
                  <article key={`${item.row_index}-${item.message}-${index}`} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    Riga {item.row_index}: {item.message}
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
