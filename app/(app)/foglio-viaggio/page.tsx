"use client";

import { useEffect, useMemo, useState } from "react";
import { DateInput } from "@/components/ui";
import { hasSupabaseEnv, supabase, getToken} from "@/lib/supabase/client";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type ServiceRow = {
  id: string;
  time: string;
  direction: string;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  pax: number;
  vessel: string | null;
  hotel_name: string | null;
  hotel_zone: string | null;
  meeting_point: string | null;
  place_type: string | null;
  phone: string | null;
  notes: string | null;
  status: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  vehicle_label: string | null;
};

type VehicleGroup = {
  vehicle_label: string;
  services: ServiceRow[];
};

type FoglioData = {
  date: string;
  groups: VehicleGroup[];
  unassigned: ServiceRow[];
  total_services: number;
  total_pax: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────


function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function clientName(s: ServiceRow) {
  if (s.customer_first_name || s.customer_last_name)
    return [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ");
  return s.customer_name;
}

function directionLabel(s: ServiceRow) {
  const kind = s.service_type_code ?? s.booking_service_kind ?? "";
  if (kind.includes("airport") || s.place_type === "airport") return { icon: "✈️", label: s.direction === "arrival" ? "Arrivo aeroporto" : "Partenza aeroporto" };
  if (kind.includes("station") || kind.includes("train") || s.place_type === "station") return { icon: "🚂", label: s.direction === "arrival" ? "Arrivo stazione" : "Partenza stazione" };
  if (s.direction === "arrival") return { icon: "📥", label: "Arrivo" };
  return { icon: "📤", label: "Partenza" };
}

function statusBadge(status: string | null) {
  switch (status) {
    case "completato": return "bg-emerald-100 text-emerald-700";
    case "partito":    return "bg-blue-100 text-blue-700";
    case "arrivato":   return "bg-sky-100 text-sky-700";
    case "problema":   return "bg-rose-100 text-rose-700";
    default:           return "bg-slate-100 text-slate-600";
  }
}

function statusLabel(status: string | null) {
  switch (status) {
    case "completato": return "Completato";
    case "partito":    return "Partito";
    case "arrivato":   return "Arrivato";
    case "problema":   return "Problema";
    default:           return "In attesa";
  }
}

// ── Generatore HTML stampa ────────────────────────────────────────────────────

function buildPrintHtml(data: FoglioData): string {
  const dateLabel = fmtDate(data.date);

  const renderGroup = (label: string, services: ServiceRow[], isUnassigned = false) => {
    const rows = services.map((s, i) => {
      const dir = directionLabel(s);
      const dest = s.hotel_name
        ? s.hotel_name + (s.hotel_zone ? ` (${s.hotel_zone})` : "")
        : s.meeting_point ?? s.vessel ?? "—";
      const bg = i % 2 === 0 ? "#fff" : "#f8fafc";
      const statusText = statusLabel(s.status);
      return `<tr style="background:${bg}">
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:700;white-space:nowrap">${s.time.slice(0, 5)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;white-space:nowrap">${dir.icon} ${dir.label}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:600;text-transform:uppercase">${clientName(s)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;font-weight:700">${s.pax}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${dest}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#475569;font-size:11px">${s.vessel ?? "—"}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#475569;font-size:11px">${s.phone ?? "—"}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b;font-size:11px">${s.notes ?? ""}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-size:11px;color:#64748b">${statusText}</td>
      </tr>`;
    }).join("");

    const totalPax = services.reduce((s, x) => s + x.pax, 0);
    const headerBg = isUnassigned ? "#dc2626" : "#1e293b";

    return `
      <div style="margin-bottom:24px">
        <div style="background:${headerBg};color:white;padding:10px 16px;border-radius:6px 6px 0 0;display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:700;font-size:14px">${isUnassigned ? "⚠️ Non assegnati" : `🚗 ${label}`}</div>
          <div style="font-size:12px;opacity:0.8">${services.length} servizi · ${totalPax} pax</div>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:#f1f5f9">
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Ora</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Tipo</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Cliente</th>
              <th style="padding:6px 10px;text-align:center;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Pax</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Hotel / Dest.</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Nave/Volo</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Telefono</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Note</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Stato</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  };

  const groupsHtml = data.groups.map((g) => renderGroup(g.vehicle_label, g.services)).join("");
  const unassignedHtml = data.unassigned.length > 0 ? renderGroup("", data.unassigned, true) : "";

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<title>Foglio di viaggio — ${dateLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 12px; color: #1a1a1a; padding: 24px; background: #fff; }
  @media print {
    body { padding: 8px; }
    .no-print { display: none !important; }
    div[style*="margin-bottom:24px"] { page-break-inside: avoid; }
    @page { margin: 1cm; size: A4 landscape; }
  }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;padding-bottom:12px;border-bottom:3px solid #0f172a">
    <div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:#64748b;margin-bottom:4px">Ischia Transfer Service</div>
      <h1 style="font-size:22px;font-weight:800;color:#0f172a">Foglio di viaggio</h1>
      <div style="font-size:14px;color:#475569;margin-top:2px">${dateLabel}</div>
    </div>
    <div style="text-align:right;font-size:12px;color:#64748b">
      <div>${data.groups.length} veicoli assegnati</div>
      <div style="font-weight:700;color:#0f172a">${data.total_services} servizi · ${data.total_pax} pax totali</div>
      ${data.unassigned.length > 0 ? `<div style="color:#dc2626;font-weight:600">⚠️ ${data.unassigned.length} non assegnati</div>` : ""}
    </div>
  </div>

  ${unassignedHtml}
  ${groupsHtml}

  <div class="no-print" style="margin-top:32px;text-align:center">
    <button onclick="window.print()" style="background:#0f172a;color:white;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Stampa / Salva PDF</button>
  </div>

  <div style="margin-top:24px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;text-align:center">
    Ischia Transfer Service PMS — Generato il ${new Date().toLocaleString("it-IT")}
  </div>
</body>
</html>`;
}

// ── Componente riga servizio ──────────────────────────────────────────────────

function ServiceRow({ s }: { s: ServiceRow }) {
  const dir = directionLabel(s);
  const dest = s.hotel_name
    ? s.hotel_name + (s.hotel_zone ? ` (${s.hotel_zone})` : "")
    : s.meeting_point ?? s.vessel ?? "—";

  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="px-3 py-2 font-mono font-bold text-slate-800 whitespace-nowrap">{s.time.slice(0, 5)}</td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">{dir.icon} {dir.label}</td>
      <td className="px-3 py-2 font-semibold uppercase">{clientName(s)}</td>
      <td className="px-3 py-2 text-center font-bold">{s.pax}</td>
      <td className="px-3 py-2 text-sm text-slate-700">{dest}</td>
      <td className="px-3 py-2 text-xs text-slate-500">{s.vessel ?? "—"}</td>
      <td className="px-3 py-2 text-xs text-slate-500">{s.phone ?? "—"}</td>
      <td className="px-3 py-2 text-xs text-slate-400 max-w-[180px] truncate">{s.notes ?? ""}</td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusBadge(s.status)}`}>
          {statusLabel(s.status)}
        </span>
      </td>
    </tr>
  );
}

// ── Gruppo veicolo ────────────────────────────────────────────────────────────

function VehicleGroupBlock({ group, isUnassigned = false }: { group: { vehicle_label: string; services: ServiceRow[] }; isUnassigned?: boolean }) {
  const totalPax = group.services.reduce((s, x) => s + x.pax, 0);

  return (
    <div className="rounded-xl overflow-hidden border border-slate-200">
      <div className={`flex items-center justify-between px-4 py-2.5 ${isUnassigned ? "bg-rose-700" : "bg-slate-800"}`}>
        <div className="flex items-center gap-2">
          <span className="text-base">{isUnassigned ? "⚠️" : "🚗"}</span>
          <span className="font-bold text-white text-sm">
            {isUnassigned ? "Non assegnati" : group.vehicle_label}
          </span>
        </div>
        <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
          {group.services.length} servizi · {totalPax} pax
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Ora</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2">Cliente</th>
              <th className="px-3 py-2 text-center">Pax</th>
              <th className="px-3 py-2">Hotel / Dest.</th>
              <th className="px-3 py-2">Nave/Volo</th>
              <th className="px-3 py-2">Telefono</th>
              <th className="px-3 py-2">Note</th>
              <th className="px-3 py-2">Stato</th>
            </tr>
          </thead>
          <tbody>
            {group.services.map((s) => <ServiceRow key={s.id} s={s} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────

export default function FoglioViaggioPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<FoglioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      const token = await getToken();
      if (!token) { if (active) { setError("Login richiesto."); setLoading(false); } return; }
      const res = await fetch(`/api/ops/foglio-viaggio?date=${date}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (active) {
        if (body?.ok) {
          setData(body);
          setSelectedVehicle((current) => current ?? body.groups?.[0]?.vehicle_label ?? (body.unassigned?.length ? "__unassigned" : null));
        }
        else setError(body?.error ?? "Errore caricamento.");
        setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [date]);

  const handlePrint = () => {
    if (!data) return;
    const html = buildPrintHtml(data);
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); w.focus(); }
  };

  const totalAssigned = data ? data.groups.reduce((s, g) => s + g.services.length, 0) : 0;
  const allGroups = useMemo(() => {
    if (!data) return [];
    const groups = data.groups.map((group) => ({ ...group, isUnassigned: false }));
    if (data.unassigned.length > 0) {
      groups.unshift({ vehicle_label: "__unassigned", services: data.unassigned, isUnassigned: true });
    }
    return groups;
  }, [data]);
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((group) => {
      const label = group.isUnassigned ? "non assegnati" : group.vehicle_label;
      return label.toLowerCase().includes(q) || group.services.some((service) =>
        clientName(service).toLowerCase().includes(q) ||
        (service.hotel_name ?? "").toLowerCase().includes(q) ||
        (service.vessel ?? "").toLowerCase().includes(q),
      );
    });
  }, [allGroups, search]);
  const selectedGroup = useMemo(() => {
    if (!data) return null;
    return allGroups.find((group) => group.vehicle_label === selectedVehicle) ?? allGroups[0] ?? null;
  }, [allGroups, data, selectedVehicle]);
  const selectedServices = selectedGroup?.services ?? [];
  const selectedPax = selectedServices.reduce((sum, service) => sum + service.pax, 0);
  const missingPhones = selectedServices.filter((service) => !service.phone).length;
  const missingHotels = selectedServices.filter((service) => !service.hotel_name && !service.meeting_point).length;
  const warningCount = missingPhones + missingHotels + (selectedPax > 30 ? 1 : 0);
  const firstService = selectedServices[0] ?? null;

  const changeDay = (days: number) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + days);
    setSelectedVehicle(null);
    setDate(next.toISOString().slice(0, 10));
  };

  const routeText = (service: ServiceRow) => {
    const destination = service.hotel_name ?? service.meeting_point ?? "Destinazione da verificare";
    return service.direction === "arrival"
      ? `${service.vessel ?? "Provenienza"} → ${destination}`
      : `${destination} → ${service.vessel ?? "Partenza"}`;
  };

  return (
    <section className="space-y-5 pb-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-950">Foglio di viaggio</h1>
          <p className="mt-1 text-lg text-slate-600">{fmtDate(date)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <button onClick={() => changeDay(-1)} className="px-4 text-xl font-bold text-slate-700 hover:bg-slate-50">‹</button>
            <DateInput value={date} onChange={(iso) => { setSelectedVehicle(null); setDate(iso); }} className="border-x border-slate-200 px-5 py-3 text-center text-base font-semibold" />
            <button onClick={() => changeDay(1)} className="px-4 text-xl font-bold text-slate-700 hover:bg-slate-50">›</button>
          </div>
          <button onClick={handlePrint} disabled={!data?.total_services} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 shadow-sm hover:border-blue-200 disabled:opacity-50">🖨️ Stampa tutto</button>
          <button disabled={!data?.total_services} className="rounded-xl border border-emerald-200 bg-white px-5 py-3 text-sm font-bold text-emerald-700 shadow-sm disabled:opacity-50">🟢 Invia WhatsApp</button>
          <button disabled={!data?.total_services} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 shadow-sm disabled:opacity-50">▣ Esporta Excel</button>
          {data && data.total_services > 0 && (
            <button onClick={handlePrint} className="rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 py-3 text-sm font-extrabold text-white shadow-lg shadow-blue-500/20">▤ Genera fogli</button>
          )}
        </div>
      </header>

      {data && (
        <div className={`flex items-center justify-between rounded-2xl border px-5 py-4 text-sm font-bold ${data.unassigned.length > 0 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          <span>{data.unassigned.length > 0 ? `⚠️ ${data.unassigned.length} servizi da assegnare prima dell'invio` : `✅ Piano del giorno pronto — ${data.groups.length} giri pronti per la stampa`}</span>
          <span className="text-xs opacity-70">{data.total_services} servizi · {data.total_pax} pax</span>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
          {[
            { icon: "🧭", label: "Giri", value: data.groups.length, tint: "bg-blue-50 text-blue-700" },
            { icon: "👤", label: "Autisti", value: data.groups.length, tint: "bg-violet-50 text-violet-700" },
            { icon: "🚐", label: "Mezzi", value: data.groups.length, tint: "bg-sky-50 text-sky-700" },
            { icon: "💼", label: "Servizi", value: data.total_services, tint: "bg-emerald-50 text-emerald-700" },
            { icon: "📨", label: "Da inviare", value: Math.max(data.groups.length - 1, 0), tint: "bg-orange-50 text-orange-600" },
          ].map((kpi) => (
            <div key={kpi.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-4">
                <span className={`grid h-14 w-14 place-items-center rounded-2xl text-2xl ${kpi.tint}`}>{kpi.icon}</span>
                <div>
                  <p className="text-sm font-semibold text-slate-500">{kpi.label}</p>
                  <p className="text-4xl font-extrabold text-slate-950">{kpi.value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Contenuto */}
      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {data && !loading && data.total_services === 0 && (
        <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <p className="text-xl font-extrabold text-slate-900">Nessun servizio per questa data</p>
          <p className="mt-2 text-slate-500">Seleziona un altro giorno o verifica le prenotazioni.</p>
        </div>
      )}

      {data && !loading && data.total_services > 0 && (
        <div className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)_330px]">
          <aside className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-extrabold text-slate-950">Autisti / Giri</h2>
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">{filteredGroups.length}</span>
            </div>
            <div className="flex gap-2">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca autista, mezzo, cliente..." className="h-12 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-blue-400 focus:bg-white" />
              <button className="h-12 w-12 rounded-xl border border-slate-200 bg-white text-slate-600">≡</button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
              <span className="rounded-full bg-blue-600 px-3 py-1.5 text-white">Tutti</span>
              <span className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600">Con giri</span>
              <span className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600">Da inviare</span>
              <span className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600">Sovraccarichi</span>
            </div>
            <div className="mt-4 max-h-[620px] space-y-2 overflow-y-auto pr-1">
              {filteredGroups.map((group) => {
                const isSelected = selectedGroup?.vehicle_label === group.vehicle_label;
                const pax = group.services.reduce((sum, service) => sum + service.pax, 0);
                const first = group.services[0];
                return (
                  <button key={group.vehicle_label} onClick={() => setSelectedVehicle(group.vehicle_label)} className={`w-full rounded-2xl border p-4 text-left transition ${isSelected ? "border-blue-500 bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-500/20" : "border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50/40"}`}>
                    <div className="flex items-center gap-3">
                      <span className={`grid h-10 w-10 place-items-center rounded-full text-sm font-extrabold ${isSelected ? "bg-white/20 text-white" : group.isUnassigned ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-500"}`}>{group.isUnassigned ? "!" : group.vehicle_label.slice(0, 2).toUpperCase()}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-extrabold">{group.isUnassigned ? "Non assegnati" : group.vehicle_label}</p>
                        <p className={`truncate text-xs ${isSelected ? "text-white/80" : "text-slate-500"}`}>{first ? routeText(first) : "Nessun servizio"}</p>
                      </div>
                      <div className="text-right text-xs font-bold">
                        <p>{group.services.length} servizi</p>
                        <p>{pax} pax</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="space-y-4">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-4">
                  <span className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-lg font-extrabold text-white">{selectedGroup?.isUnassigned ? "!" : selectedGroup?.vehicle_label.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <h2 className="text-2xl font-extrabold text-slate-950">Foglio autista</h2>
                    <p className="font-bold text-slate-700">{selectedGroup?.isUnassigned ? "Servizi non assegnati" : selectedGroup?.vehicle_label}</p>
                    <p className="text-sm text-slate-500">{selectedServices.length} servizi · {selectedPax} pax</p>
                  </div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-extrabold ${warningCount > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{warningCount > 0 ? `${warningCount} controlli` : "Pronto per la stampa"}</span>
              </div>
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <table className="min-w-full text-[15px]">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Ora</th>
                      <th className="px-4 py-3">Servizio</th>
                      <th className="px-4 py-3">Percorso</th>
                      <th className="px-4 py-3 text-center">Pax</th>
                      <th className="px-4 py-3">Note</th>
                      <th className="px-4 py-3">Stato</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedServices.map((service) => {
                      const dir = directionLabel(service);
                      return (
                        <tr key={service.id} className="hover:bg-slate-50">
                          <td className="px-4 py-4 font-mono text-xl font-extrabold text-blue-700">{service.time.slice(0, 5)}</td>
                          <td className="px-4 py-4">
                            <p className="text-base font-extrabold uppercase text-slate-900">{clientName(service)}</p>
                            <p className="text-xs text-slate-500">{dir.icon} {dir.label}</p>
                          </td>
                          <td className="px-4 py-4">
                            <p className="text-base font-extrabold text-slate-800">{service.vessel ?? "—"}</p>
                            <p className="text-sm text-slate-600">→ {service.hotel_name ?? service.meeting_point ?? "Da verificare"}</p>
                          </td>
                          <td className="px-4 py-4 text-center text-base font-extrabold">{service.pax}</td>
                          <td className="px-4 py-4"><span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">{service.notes || "—"}</span></td>
                          <td className="px-4 py-4"><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusBadge(service.status)}`}>{statusLabel(service.status)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-400">Totale servizi</p><p className="text-2xl font-extrabold">{selectedServices.length}</p></div>
                <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-400">Totale pax</p><p className="text-2xl font-extrabold">{selectedPax}</p></div>
                <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-400">Prima corsa</p><p className="text-2xl font-extrabold">{firstService?.time.slice(0, 5) ?? "—"}</p></div>
                <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-bold text-slate-400">Controlli</p><p className="text-2xl font-extrabold">{warningCount}</p></div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-xl font-extrabold text-slate-950">Anteprima messaggio WhatsApp</h3>
              <div className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-slate-800">
                Ciao, ecco il tuo foglio di viaggio per {fmtDate(date)}. Hai {selectedServices.length} servizi, {selectedPax} pax totali. Prima corsa prevista alle {firstService?.time.slice(0, 5) ?? "—"}. Buon lavoro! 🚌
              </div>
            </div>
          </main>

          <aside className="space-y-4">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-extrabold text-slate-950">Controlli foglio</h2>
                <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">{warningCount} segnalazioni</span>
              </div>
              <div className="divide-y divide-slate-100">
                <div className="flex items-center justify-between py-3"><span>Telefono mancante</span><strong>{missingPhones}</strong></div>
                <div className="flex items-center justify-between py-3"><span>Hotel da verificare</span><strong>{missingHotels}</strong></div>
                <div className="flex items-center justify-between py-3"><span>Giro sovraccarico</span><strong>{selectedPax > 30 ? 1 : 0}</strong></div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-extrabold text-slate-950">Azioni rapide</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-bold text-emerald-700">WhatsApp</button>
                <button onClick={handlePrint} className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-bold text-blue-700">Scarica PDF</button>
                <button className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-slate-700">Apri giro</button>
                <button className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-slate-700">Modifica giro</button>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-extrabold text-slate-950">Riepilogo</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between"><span>Assegnati</span><strong>{totalAssigned}</strong></div>
                <div className="flex justify-between"><span>Totale servizi</span><strong>{data.total_services}</strong></div>
                <div className="flex justify-between"><span>Totale pax</span><strong>{data.total_pax}</strong></div>
                <div className="flex justify-between"><span>Non assegnati</span><strong>{data.unassigned.length}</strong></div>
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
