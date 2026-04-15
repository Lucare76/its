"use client";

import { useEffect, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

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

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

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
        if (body?.ok) setData(body);
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

  return (
    <section className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Foglio di viaggio</h1>
          <p className="text-sm text-slate-500">Servizi del giorno raggruppati per veicolo</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          {data && data.total_services > 0 && (
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900">
              🖨️ Stampa PDF
            </button>
          )}
        </div>
      </div>

      {/* KPI */}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Servizi totali", value: data.total_services, color: "text-slate-800" },
            { label: "Pax totali", value: data.total_pax, color: "text-blue-700" },
            { label: "Veicoli", value: data.groups.length, color: "text-emerald-700" },
            { label: "Non assegnati", value: data.unassigned.length, color: data.unassigned.length > 0 ? "text-rose-600" : "text-slate-400" },
          ].map((kpi) => (
            <div key={kpi.label} className="card p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{kpi.label}</p>
              <p className={`mt-1 text-3xl font-bold ${kpi.color}`}>{kpi.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Contenuto */}
      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {data && !loading && (
        <div className="space-y-4">
          {/* Non assegnati — in cima se presenti */}
          {data.unassigned.length > 0 && (
            <VehicleGroupBlock
              group={{ vehicle_label: "", services: data.unassigned }}
              isUnassigned
            />
          )}

          {/* Gruppi per veicolo */}
          {data.groups.length === 0 && data.unassigned.length === 0 && (
            <div className="card p-10 text-center text-slate-400">
              <p className="text-lg font-semibold">Nessun servizio per questa data</p>
              <p className="mt-1 text-sm">Seleziona un altro giorno o verifica le prenotazioni.</p>
            </div>
          )}
          {data.groups.map((group) => (
            <VehicleGroupBlock key={group.vehicle_label} group={group} />
          ))}

          {/* Riepilogo finale */}
          {data.total_services > 0 && (
            <div className="card p-4 flex flex-wrap gap-6 text-sm text-slate-600">
              <span>✅ Assegnati: <strong className="text-slate-800">{totalAssigned}</strong></span>
              <span>📊 Totale: <strong className="text-slate-800">{data.total_services}</strong></span>
              <span>👥 Pax: <strong className="text-slate-800">{data.total_pax}</strong></span>
              {data.unassigned.length > 0 && (
                <span className="text-rose-600">⚠️ Non assegnati: <strong>{data.unassigned.length}</strong></span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
