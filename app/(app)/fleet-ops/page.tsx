"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Vehicle = {
  id: string;
  label: string;
  plate?: string | null;
  capacity?: number | null;
  active: boolean;
  vehicle_size?: "small" | "medium" | "large" | "bus" | null;
  habitual_driver_user_id?: string | null;
  default_zone?: string | null;
  blocked_until?: string | null;
  blocked_reason?: string | null;
  notes?: string | null;
  is_blocked_manual?: boolean | null;
  radius_vehicle_id?: string | null;
};

type Driver = { user_id: string; full_name: string };

type Anomaly = {
  id: string;
  vehicle_id: string;
  severity: "low" | "medium" | "high" | "blocking";
  title: string;
  description?: string | null;
  blocked_until?: string | null;
  active: boolean;
  reported_at: string;
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function FleetOpsPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Mezzi, autisti abituali e anomalie veicoli.");
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>("");

  const load = useEffectEvent(async () => {
    const token = await accessToken();
    if (!token) {
      setLoading(false);
      setMessage("Sessione non valida.");
      return;
    }
    const response = await fetch("/api/ops/vehicles", { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; vehicles?: Vehicle[]; drivers?: Driver[]; anomalies?: Anomaly[] } | null;
    if (!response.ok || !body?.ok) {
      setLoading(false);
      setMessage(body?.error ?? "Errore caricamento flotta.");
      return;
    }
    setVehicles(body.vehicles ?? []);
    setDrivers(body.drivers ?? []);
    setAnomalies(body.anomalies ?? []);
    setSelectedVehicleId((current) => current || body.vehicles?.[0]?.id || "");
    setLoading(false);
  });

  useEffect(() => {
    void load();
  }, []);

  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? vehicles[0] ?? null;
  const selectedAnomalies = anomalies.filter((item) => item.vehicle_id === selectedVehicle?.id && item.active);
  const driverNameById = useMemo(() => new Map(drivers.map((driver) => [driver.user_id, driver.full_name])), [drivers]);

  const post = async (body: Record<string, unknown>) => {
    const token = await accessToken();
    if (!token) return;
    const response = await fetch("/api/ops/vehicles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const json = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; vehicles?: Vehicle[]; anomalies?: Anomaly[]; drivers?: Driver[] } | null;
    if (!response.ok || !json?.ok) {
      setMessage(json?.error ?? "Operazione flotta non riuscita.");
      return;
    }
    setVehicles(json.vehicles ?? []);
    setDrivers(json.drivers ?? []);
    setAnomalies(json.anomalies ?? []);
    setMessage("Flotta aggiornata.");
  };

  if (loading) {
    return (
      <section className="page-section">
        <p className="text-sm text-muted">Caricamento flotta...</p>
      </section>
    );
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Mezzi e Autisti Ischia"
        subtitle="Associazione mezzo <-> autista abituale, blocchi veicolo e anomalie."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta Ops" }]}
      />

      <p className="text-sm text-muted">{message}</p>

      <div className="grid gap-3 md:grid-cols-4">
        <SectionCard title="Mezzi attivi"><p className="text-3xl font-semibold text-text">{vehicles.filter((item) => item.active).length}</p></SectionCard>
        <SectionCard title="Mezzi bloccati"><p className="text-3xl font-semibold text-rose-700">{vehicles.filter((item) => item.is_blocked_manual || item.blocked_until).length}</p></SectionCard>
        <SectionCard title="Anomalie aperte"><p className="text-3xl font-semibold text-amber-700">{anomalies.filter((item) => item.active).length}</p></SectionCard>
        <SectionCard title="Autisti"><p className="text-3xl font-semibold text-text">{drivers.length}</p></SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <SectionCard title="Veicoli" subtitle="Suggeriti ma sempre modificabili manualmente">
          <div className="space-y-2">
            {vehicles.map((vehicle) => (
              <button
                key={vehicle.id}
                type="button"
                onClick={() => setSelectedVehicleId(vehicle.id)}
                className={`w-full rounded-xl border px-4 py-3 text-left ${selectedVehicle?.id === vehicle.id ? "border-blue-300 bg-blue-50/60" : "border-border bg-white"}`}
              >
                <p className="font-semibold">{vehicle.label}</p>
                <p className="text-xs text-muted">
                  {vehicle.vehicle_size ?? "size N/D"} | {vehicle.plate ?? "targa N/D"} | {vehicle.default_zone ?? "zona libera"}
                  {vehicle.is_blocked_manual || vehicle.blocked_until ? " | BLOCCATO" : ""}
                </p>
              </button>
            ))}
            {vehicles.length === 0 ? <p className="text-sm text-muted">Nessun mezzo disponibile.</p> : null}
          </div>
        </SectionCard>

        <SectionCard title="Dettaglio mezzo" subtitle="Autista abituale e anomalie">
          {!selectedVehicle ? (
            <p className="text-sm text-muted">Seleziona un mezzo.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                <input id="fleet-label" className="input-saas" defaultValue={selectedVehicle.label} />
                <input id="fleet-plate" className="input-saas" defaultValue={selectedVehicle.plate ?? ""} placeholder="Targa" />
                <select id="fleet-size" className="input-saas" defaultValue={selectedVehicle.vehicle_size ?? "medium"}>
                  <option value="small">small</option>
                  <option value="medium">medium</option>
                  <option value="large">large</option>
                  <option value="bus">bus</option>
                </select>
                <select id="fleet-driver" className="input-saas" defaultValue={selectedVehicle.habitual_driver_user_id ?? ""}>
                  <option value="">Nessun autista abituale</option>
                  {drivers.map((driver) => <option key={driver.user_id} value={driver.user_id}>{driver.full_name}</option>)}
                </select>
                <input id="fleet-zone" className="input-saas" defaultValue={selectedVehicle.default_zone ?? ""} placeholder="Zona abituale / hotel area" />
                <input id="fleet-blocked-until" className="input-saas" type="datetime-local" defaultValue={selectedVehicle.blocked_until ? selectedVehicle.blocked_until.slice(0, 16) : ""} />
                <input id="fleet-blocked-reason" className="input-saas md:col-span-2" defaultValue={selectedVehicle.blocked_reason ?? ""} placeholder="Motivo blocco" />
                <textarea id="fleet-notes" className="input-saas md:col-span-2 min-h-[90px]" defaultValue={selectedVehicle.notes ?? ""} placeholder="Note mezzo" />
                <input
                  id="fleet-radius-id"
                  className="input-saas md:col-span-2"
                  defaultValue={selectedVehicle.radius_vehicle_id ?? ""}
                  placeholder="ID veicolo GPS Radius (es. VH-1234)"
                />
              </div>
              {selectedVehicle.radius_vehicle_id ? (
                <a
                  href="/mappa-live"
                  className="inline-block rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-100"
                >
                  Apri su Mappa Live GPS
                </a>
              ) : null}
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                onClick={() =>
                  void post({
                    action: "upsert_vehicle",
                    id: selectedVehicle.id,
                    label: (document.getElementById("fleet-label") as HTMLInputElement | null)?.value ?? selectedVehicle.label,
                    plate: (document.getElementById("fleet-plate") as HTMLInputElement | null)?.value ?? "",
                    vehicle_size: (document.getElementById("fleet-size") as HTMLSelectElement | null)?.value ?? "medium",
                    habitual_driver_user_id: (document.getElementById("fleet-driver") as HTMLSelectElement | null)?.value ?? null,
                    default_zone: (document.getElementById("fleet-zone") as HTMLInputElement | null)?.value ?? "",
                    blocked_until: (document.getElementById("fleet-blocked-until") as HTMLInputElement | null)?.value || null,
                    blocked_reason: (document.getElementById("fleet-blocked-reason") as HTMLInputElement | null)?.value ?? "",
                    notes: (document.getElementById("fleet-notes") as HTMLTextAreaElement | null)?.value ?? "",
                    radius_vehicle_id: (document.getElementById("fleet-radius-id") as HTMLInputElement | null)?.value || null,
                    capacity: selectedVehicle.capacity ?? null,
                    is_blocked_manual: Boolean((document.getElementById("fleet-blocked-reason") as HTMLInputElement | null)?.value)
                  })
                }
              >
                Salva mezzo
              </button>

              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium">Segnala anomalia</p>
                <div className="grid gap-2">
                  <input id="anomaly-title" className="input-saas" placeholder="Titolo anomalia" />
                  <select id="anomaly-severity" className="input-saas" defaultValue="medium">
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="blocking">blocking</option>
                  </select>
                  <input id="anomaly-blocked-until" className="input-saas" type="datetime-local" />
                  <textarea id="anomaly-description" className="input-saas min-h-[90px]" placeholder="Descrizione" />
                  <button
                    type="button"
                    className="btn-secondary px-4 py-2 text-sm"
                    onClick={() =>
                      void post({
                        action: "report_anomaly",
                        vehicle_id: selectedVehicle.id,
                        title: (document.getElementById("anomaly-title") as HTMLInputElement | null)?.value ?? "",
                        severity: (document.getElementById("anomaly-severity") as HTMLSelectElement | null)?.value ?? "medium",
                        blocked_until: (document.getElementById("anomaly-blocked-until") as HTMLInputElement | null)?.value || null,
                        description: (document.getElementById("anomaly-description") as HTMLTextAreaElement | null)?.value ?? ""
                      })
                    }
                  >
                    Invia segnalazione
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Storico anomalie aperte</p>
                {selectedAnomalies.map((anomaly) => (
                  <article key={anomaly.id} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">{anomaly.title}</p>
                      <span>{anomaly.severity}</span>
                    </div>
                    <p className="text-muted">{anomaly.description ?? "Nessuna descrizione"}</p>
                    <p className="text-xs text-muted">Segnalata il {new Date(anomaly.reported_at).toLocaleString("it-IT")}</p>
                    <button
                      type="button"
                      className="btn-secondary mt-2 px-3 py-1.5 text-xs"
                      onClick={() => void post({ action: "resolve_anomaly", anomaly_id: anomaly.id, vehicle_id: selectedVehicle.id })}
                    >
                      Risolvi anomalia
                    </button>
                  </article>
                ))}
                {selectedAnomalies.length === 0 ? <p className="text-sm text-muted">Nessuna anomalia aperta per questo mezzo.</p> : null}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Abbinamenti autista <-> mezzo" subtitle="L'assegnazione resta manuale, ma qui consolidi i mezzi abituali">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Mezzo</th>
                <th className="px-3 py-2">Autista abituale</th>
                <th className="px-3 py-2">Zona</th>
                <th className="px-3 py-2">GPS Radius</th>
                <th className="px-3 py-2">Disponibilita</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((vehicle) => (
                <tr key={vehicle.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{vehicle.label}</td>
                  <td className="px-3 py-2">
                    {vehicle.habitual_driver_user_id ? driverNameById.get(vehicle.habitual_driver_user_id) ?? vehicle.habitual_driver_user_id : "N/D"}
                  </td>
                  <td className="px-3 py-2">{vehicle.default_zone ?? "N/D"}</td>
                  <td className="px-3 py-2">
                    {vehicle.radius_vehicle_id ? (
                      <span className="text-teal-700 font-medium">{vehicle.radius_vehicle_id}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{vehicle.is_blocked_manual || vehicle.blocked_until ? "Non disponibile" : "Disponibile"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </section>
  );
}
