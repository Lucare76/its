"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { inferZoneFromText, zoneCentroids } from "@/lib/hotel-geocoding";
import {
  onboardingDriverSchema,
  onboardingGeoSettingsSchema,
  onboardingTenantSchema,
  vehicleCreateSchema
} from "@/lib/validation";

type WizardStep = 1 | 2 | 3 | 4;

type DriverInput = {
  full_name: string;
  email: string;
  password: string;
};

type VehicleInput = {
  label: string;
  plate: string;
  capacity: number | null;
};

type ParsedHotel = {
  name: string;
  address: string;
  zone: string;
  lat: number;
  lng: number;
};

function normalizeItems(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function parseHotelCsv(text: string): ParsedHotel[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const separator = lines[0]?.includes(";") ? ";" : ",";
  const headers = (lines[0] ?? "")
    .split(separator)
    .map((item) => item.trim().toLowerCase().replace(/\s+/g, "_"));

  const idxName = headers.indexOf("name");
  const idxAddress = headers.indexOf("address");
  const idxZone = headers.indexOf("zone");
  const idxLat = headers.indexOf("lat");
  const idxLng = headers.indexOf("lng");

  if (idxName < 0 || idxAddress < 0 || idxZone < 0) {
    throw new Error("CSV non valido: colonne richieste name,address,zone.");
  }

  const rows: ParsedHotel[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(separator).map((item) => item.trim());
    const name = cells[idxName] ?? "";
    const address = cells[idxAddress] ?? "";
    const zoneRaw = cells[idxZone] ?? "";
    const zoneGuess = inferZoneFromText(zoneRaw) ?? inferZoneFromText(address) ?? "Ischia Porto";
    const zone = zoneRaw || zoneGuess;

    const latRaw = idxLat >= 0 ? Number(cells[idxLat]) : NaN;
    const lngRaw = idxLng >= 0 ? Number(cells[idxLng]) : NaN;
    const centroid = zoneCentroids[(zoneGuess ?? "Ischia Porto") as keyof typeof zoneCentroids] ?? zoneCentroids["Ischia Porto"];
    const lat = Number.isFinite(latRaw) ? latRaw : centroid.lat;
    const lng = Number.isFinite(lngRaw) ? lngRaw : centroid.lng;

    if (!name || !address || !zone) continue;
    rows.push({ name, address, zone, lat, lng });
  }
  return rows;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(1);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [message, setMessage] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const [driverDraft, setDriverDraft] = useState<DriverInput>({ full_name: "", email: "", password: "" });
  const [drivers, setDrivers] = useState<DriverInput[]>([]);
  const [vehicleDraft, setVehicleDraft] = useState<VehicleInput>({ label: "", plate: "", capacity: null });
  const [vehicles, setVehicles] = useState<VehicleInput[]>([]);

  const [hotelRows, setHotelRows] = useState<ParsedHotel[]>([]);
  const [zonesText, setZonesText] = useState("");
  const [portsText, setPortsText] = useState("");
  const [showAdvancedSetup, setShowAdvancedSetup] = useState(false);

  const loadContext = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.access_token) {
      setMessage("Sessione non valida.");
      return;
    }

    const response = await fetch("/api/onboarding/tenant", {
      headers: {
        Authorization: `Bearer ${sessionData.session.access_token}`
      }
    });
    const body = (await response.json().catch(() => null)) as
      | { error?: string; hasTenant?: boolean; tenant?: { id: string; name: string } }
      | null;
    if (!response.ok) {
      setMessage(body?.error ?? "Errore caricamento onboarding.");
      return;
    }

    if (body?.hasTenant && body.tenant?.id) {
      setTenantId(body.tenant.id);
      setCompanyName(body.tenant.name ?? "");
      setStep(2);
      setShowAdvancedSetup(false);
      await loadGeoSettings(body.tenant.id);
    } else {
      setStep(1);
    }
  };

  useEffect(() => {
    void loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadGeoSettings = async (currentTenantId: string) => {
    if (!hasSupabaseEnv || !supabase) return;
    const [{ data: geo }, { data: hotels }] = await Promise.all([
      supabase.from("tenant_geo_settings").select("zones, ports").eq("tenant_id", currentTenantId).maybeSingle(),
      supabase.from("hotels").select("zone").eq("tenant_id", currentTenantId)
    ]);

    const distinctHotelZones = Array.from(new Set((hotels ?? []).map((item) => item.zone as string))).filter(Boolean);
    const zones = (geo?.zones as string[] | undefined) ?? distinctHotelZones;
    const ports = (geo?.ports as string[] | undefined) ?? [];

    setZonesText(zones.join("\n"));
    setPortsText(ports.join("\n"));
  };

  const stepBadges = useMemo(
    () => [
      { id: 1, label: "Azienda" },
      { id: 2, label: "Driver+Mezzi" },
      { id: 3, label: "Hotel CSV" },
      { id: 4, label: "Zone/Porti" }
    ],
    []
  );

  const createTenant = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }
    const parsed = onboardingTenantSchema.safeParse({ company_name: companyName });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Nome azienda non valido.");
      return;
    }

    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setMessage("Sessione non valida.");
        setLoading(false);
        return;
      }

      const response = await fetch("/api/onboarding/tenant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(parsed.data)
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; tenant?: { id: string; name: string } }
        | null;
      if (!response.ok || !body?.tenant?.id) {
        setMessage(body?.error ?? "Errore creazione tenant.");
        setLoading(false);
        return;
      }

      setTenantId(body.tenant.id);
      setCompanyName(body.tenant.name);
      setStep(2);
      setShowAdvancedSetup(false);
      setMessage("Step 1 completato. Reindirizzamento alla dashboard...");
      await loadGeoSettings(body.tenant.id);
      window.setTimeout(() => {
        router.push("/dashboard");
      }, 450);
    } finally {
      setLoading(false);
    }
  };

  const addDriver = () => {
    const parsed = onboardingDriverSchema.safeParse(driverDraft);
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Driver non valido.");
      return;
    }
    setDrivers((prev) => [...prev, parsed.data]);
    setDriverDraft({ full_name: "", email: "", password: "" });
  };

  const addVehicle = () => {
    const parsed = vehicleCreateSchema.safeParse({
      label: vehicleDraft.label,
      plate: vehicleDraft.plate,
      capacity: vehicleDraft.capacity
    });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Mezzo non valido.");
      return;
    }
    setVehicles((prev) => [
      ...prev,
      {
        label: parsed.data.label,
        plate: parsed.data.plate ?? "",
        capacity: parsed.data.capacity ?? null
      }
    ]);
    setVehicleDraft({ label: "", plate: "", capacity: null });
  };

  const saveStep2 = async () => {
    if (!tenantId) {
      setMessage("Tenant non disponibile.");
      return;
    }
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }
    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setMessage("Sessione non valida.");
        setLoading(false);
        return;
      }

      if (drivers.length > 0) {
        const response = await fetch("/api/onboarding/drivers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            tenant_id: tenantId,
            drivers
          })
        });
        const body = (await response.json().catch(() => null)) as
          | { error?: string; created?: Array<{ email: string }>; failed?: Array<{ email: string; error: string }> }
          | null;
        if (!response.ok) {
          setMessage(body?.error ?? "Errore creazione driver.");
          setLoading(false);
          return;
        }
        if ((body?.failed?.length ?? 0) > 0) {
          setMessage(`Driver creati con avviso: ${body?.failed?.length} non inseriti.`);
        }
      }

      if (vehicles.length > 0) {
        const { error: vehiclesError } = await supabase.from("vehicles").insert(
          vehicles.map((item) => ({
            tenant_id: tenantId,
            label: item.label,
            plate: item.plate || null,
            capacity: item.capacity,
            active: true
          }))
        );
        if (vehiclesError) {
          setMessage(vehiclesError.message);
          setLoading(false);
          return;
        }
      }

      setDrivers([]);
      setVehicles([]);
      setStep(3);
      setMessage("Passo 2 completato.");
    } finally {
      setLoading(false);
    }
  };

  const onHotelCsv = async (file: File) => {
    const text = await file.text();
    try {
      const parsed = parseHotelCsv(text);
      setHotelRows(parsed);
      setMessage(`CSV letto: ${parsed.length} hotel pronti.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore parsing CSV.");
      setHotelRows([]);
    }
  };

  const importHotels = async () => {
    if (!tenantId) {
      setMessage("Tenant non disponibile.");
      return;
    }
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }
    if (hotelRows.length === 0) {
      setMessage("Nessun hotel da importare.");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.from("hotels").insert(
        hotelRows.map((row) => ({
          tenant_id: tenantId,
          name: row.name,
          address: row.address,
          zone: row.zone,
          lat: row.lat,
          lng: row.lng
        }))
      );
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }

      setStep(4);
      setMessage(`Step 3 completato: importati ${hotelRows.length} hotel.`);
      setHotelRows([]);
      await loadGeoSettings(tenantId);
    } finally {
      setLoading(false);
    }
  };

  const saveGeoSettings = async () => {
    if (!tenantId) {
      setMessage("Tenant non disponibile.");
      return;
    }
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }

    const payload = {
      tenant_id: tenantId,
      zones: normalizeItems(zonesText),
      ports: normalizeItems(portsText)
    };
    const parsed = onboardingGeoSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Zone/porti non validi.");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.from("tenant_geo_settings").upsert({
        ...parsed.data,
        updated_at: new Date().toISOString()
      });
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }

      setMessage("Onboarding completato.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mx-auto max-w-4xl space-y-4 pb-8">
      <header className="card space-y-3 p-4">
        <h1 className="text-xl font-semibold">Onboarding Tenant</h1>
        <p className="text-sm text-muted">Per iniziare la demo basta creare l&apos;azienda (Step 1).</p>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 p-3 text-xs">
          <p className="text-muted">Setup avanzato (driver, mezzi, hotel CSV, zone) opzionale: puoi farlo anche dopo.</p>
          <button type="button" onClick={() => setShowAdvancedSetup((prev) => !prev)} className="btn-secondary px-3 py-1.5 text-xs">
            {showAdvancedSetup ? "Nascondi setup avanzato" : "Mostra setup avanzato"}
          </button>
        </div>
        {showAdvancedSetup ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stepBadges.map((item) => (
              <div
                key={item.id}
                className={`rounded-xl border px-3 py-2 text-xs ${
                  step >= (item.id as WizardStep) ? "border-blue-300 bg-blue-50 text-blue-900" : "border-border text-muted"
                }`}
              >
                Step {item.id}: {item.label}
              </div>
            ))}
          </div>
        ) : null}
      </header>

      <article className="card space-y-3 p-4">
        <h2 className="text-base font-semibold">Step 1 - Crea azienda</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input-saas flex-1"
            placeholder="Nome azienda"
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
          />
          <button type="button" onClick={() => void createTenant()} disabled={loading} className="btn-primary h-[42px] px-4 disabled:opacity-50">
            {loading ? "Salvataggio..." : "Salva Step 1"}
          </button>
        </div>
        {tenantId ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">Tenant attivo: {tenantId}</p>
            <Link href="/dashboard" className="btn-secondary px-3 py-1.5 text-xs">
              Vai alla dashboard
            </Link>
          </div>
        ) : null}
      </article>

      {showAdvancedSetup && step >= 2 ? (
        <article className="card space-y-4 p-4">
          <h2 className="text-base font-semibold">Passo 2 - Driver e mezzi</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-border p-3">
              <p className="text-sm font-medium">Aggiungi driver</p>
              <input
                className="input-saas w-full"
                placeholder="Nome completo"
                value={driverDraft.full_name}
                onChange={(event) => setDriverDraft((prev) => ({ ...prev, full_name: event.target.value }))}
              />
              <input
                className="input-saas w-full"
                placeholder="Email"
                value={driverDraft.email}
                onChange={(event) => setDriverDraft((prev) => ({ ...prev, email: event.target.value }))}
              />
              <input
                className="input-saas w-full"
                placeholder="Password temporanea (min 8)"
                type="password"
                value={driverDraft.password}
                onChange={(event) => setDriverDraft((prev) => ({ ...prev, password: event.target.value }))}
              />
              <button type="button" onClick={addDriver} className="btn-secondary px-3 py-2 text-sm">
                Aggiungi driver alla lista
              </button>
              <ul className="space-y-1 text-xs text-muted">
                {drivers.map((item, index) => (
                  <li key={`${item.email}-${index}`}>{item.full_name} - {item.email}</li>
                ))}
              </ul>
            </div>

            <div className="space-y-2 rounded-xl border border-border p-3">
              <p className="text-sm font-medium">Aggiungi mezzo</p>
              <input
                className="input-saas w-full"
                placeholder="Etichetta (es. Van 8 posti)"
                value={vehicleDraft.label}
                onChange={(event) => setVehicleDraft((prev) => ({ ...prev, label: event.target.value }))}
              />
              <input
                className="input-saas w-full"
                placeholder="Targa"
                value={vehicleDraft.plate}
                onChange={(event) => setVehicleDraft((prev) => ({ ...prev, plate: event.target.value }))}
              />
              <input
                className="input-saas w-full"
                placeholder="Capacita"
                type="number"
                min={1}
                value={vehicleDraft.capacity ?? ""}
                onChange={(event) =>
                  setVehicleDraft((prev) => ({
                    ...prev,
                    capacity: event.target.value ? Number(event.target.value) : null
                  }))
                }
              />
              <button type="button" onClick={addVehicle} className="btn-secondary px-3 py-2 text-sm">
                Aggiungi mezzo alla lista
              </button>
              <ul className="space-y-1 text-xs text-muted">
                {vehicles.map((item, index) => (
                  <li key={`${item.label}-${index}`}>
                    {item.label} {item.plate ? `(${item.plate})` : ""} {item.capacity ? `- ${item.capacity} posti` : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <button type="button" onClick={() => void saveStep2()} disabled={loading} className="btn-primary h-[42px] px-4 disabled:opacity-50">
            {loading ? "Salvataggio..." : "Salva Passo 2"}
          </button>
        </article>
      ) : null}

      {showAdvancedSetup && step >= 3 ? (
        <article className="card space-y-3 p-4">
          <h2 className="text-base font-semibold">Step 3 - Import hotel CSV</h2>
          <p className="text-xs text-muted">CSV semplice con header: `name,address,zone,lat,lng` (lat/lng opzionali).</p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onHotelCsv(file);
            }}
            className="text-sm"
          />
          <p className="text-xs text-muted">Righe pronte: {hotelRows.length}</p>
          <button type="button" onClick={() => void importHotels()} disabled={loading || hotelRows.length === 0} className="btn-primary h-[42px] px-4 disabled:opacity-50">
            {loading ? "Import..." : "Salva Step 3"}
          </button>
        </article>
      ) : null}

      {showAdvancedSetup && step >= 4 ? (
        <article className="card space-y-3 p-4">
          <h2 className="text-base font-semibold">Step 4 - Zone e porti</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Zone (una per riga o separate da virgola)
              <textarea className="input-saas mt-1 min-h-36 w-full" value={zonesText} onChange={(event) => setZonesText(event.target.value)} />
            </label>
            <label className="text-xs text-muted">
              Porti (una per riga o separate da virgola)
              <textarea className="input-saas mt-1 min-h-36 w-full" value={portsText} onChange={(event) => setPortsText(event.target.value)} />
            </label>
          </div>
          <button type="button" onClick={() => void saveGeoSettings()} disabled={loading} className="btn-primary h-[42px] px-4 disabled:opacity-50">
            {loading ? "Salvataggio..." : "Completa onboarding"}
          </button>
        </article>
      ) : null}

      {message ? <p className="card p-3 text-sm text-muted">{message}</p> : null}
    </section>
  );
}
