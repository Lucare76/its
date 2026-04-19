"use client";

import { useCallback, useEffect, useState } from "react";
import { DateInput, PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type PlaceType = "station" | "airport";

type BrunoService = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  boat_t?: string | null;              // orario traghetto da ischia (partenze)
  arrival_at_porto?: string | null;    // orario arrivo al porto continentale (partenze — quando Bruno si fa trovare)
  arrival_at_ischia?: string | null;   // orario arrivo traghetto a Ischia (arrivi — per autisti sull'isola)
  connection_time?: string | null;     // orario volo/treno/bus del cliente
  place_type: PlaceType;
  meeting_point: string | null;
  phone: string;
  porto_bruno: string | null;
  hotel_name: string | null;
  notes: string;
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

function fmtDateShort(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", {
    weekday: "short", day: "numeric", month: "short",
  });
}

function portoDaVessel(vessel: string): string {
  const v = vessel.toLowerCase();
  if (v.includes("medmar")) return "Pozzuoli";
  if (v.includes("snav")) return "Napoli Beverello";
  if (v.includes("alilauro")) return "Napoli Beverello";
  return "";
}

function PlaceBadge({ type, point }: { type: PlaceType; point: string | null }) {
  const label = point?.trim() || (type === "station" ? "Stazione" : "Aeroporto");
  return type === "station"
    ? <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">🚂 {label}</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">✈️ {label}</span>;
}

// ── Generatore HTML stampa ────────────────────────────────────────────────────

function buildPrintHtml(date: string, arrivals: BrunoService[], departures: BrunoService[]): string {
  const dateLabel = fmtDate(date);

  const arrivalRows = [...arrivals]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((a, i) => {
      const place = a.meeting_point?.trim() || (a.place_type === "station" ? "Stazione" : "Aeroporto");
      const icon = a.place_type === "station" ? "🚂" : "✈️";
      const bg = i % 2 === 0 ? "#fff" : "#f8fafc";
      return `<tr style="background:${bg}">
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:700;white-space:nowrap">${a.time.slice(0, 5)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:600;text-transform:uppercase">${a.customer_name}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center">${a.pax}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;white-space:nowrap">${icon} ${place}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${a.vessel}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${a.hotel_name ?? "—"}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#475569;font-size:11px">${a.phone}${a.notes ? ` · ${a.notes}` : ""}</td>
      </tr>`;
    }).join("");

  // Raggruppa partenze per vessel
  const byVessel = departures.reduce<Record<string, BrunoService[]>>((acc, d) => {
    (acc[d.vessel] ??= []).push(d);
    return acc;
  }, {});

  const departureSections = Object.entries(byVessel)
    .sort(([a], [b]) => {
      const ta = departures.find(d => d.vessel === a)?.time ?? "";
      const tb = departures.find(d => d.vessel === b)?.time ?? "";
      return ta.localeCompare(tb);
    })
    .map(([vessel, group]) => {
      const totalPax = group.reduce((s, d) => s + d.pax, 0);
      const boatT = group.find(d => d.boat_t)?.boat_t ?? null;
      const porto = group[0]?.porto_bruno || portoDaVessel(vessel) || "—";
      const connTime = group.find(d => d.connection_time)?.connection_time ?? null;
      const arrivalAtPorto = group.find(d => d.arrival_at_porto)?.arrival_at_porto ?? null;
      const rows = [...group]
        .sort((a, b) => a.customer_name.localeCompare(b.customer_name))
        .map((d, i) => {
          const dest = d.meeting_point?.trim() || (d.place_type === "station" ? "Stazione" : "Aeroporto");
          const icon = d.place_type === "station" ? "🚂" : "✈️";
          const bg = i % 2 === 0 ? "#fff" : "#f8fafc";
          const porto_row = d.porto_bruno || portoDaVessel(d.vessel) || "—";
          const connRow = d.connection_time ? `${icon} ${d.connection_time.slice(0, 5)}` : "";
          return `<tr style="background:${bg}">
            <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:600;text-transform:uppercase">${d.customer_name}</td>
            <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center">${d.pax}</td>
            <td style="padding:7px 10px;border:1px solid #e2e8f0;white-space:nowrap">⚓ ${porto_row}</td>
            <td style="padding:7px 10px;border:1px solid #e2e8f0;white-space:nowrap;color:#c2410c;font-weight:600">${connRow}</td>
            <td style="padding:7px 10px;border:1px solid #e2e8f0;white-space:nowrap">${icon} ${dest}</td>
            <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#475569;font-size:11px">${d.phone}${d.notes ? ` · ${d.notes}` : ""}</td>
          </tr>`;
        }).join("");

      return `
        <div style="margin-bottom:20px">
          <div style="background:#1e293b;color:white;padding:9px 14px;border-radius:6px 6px 0 0;font-weight:700;font-size:13px">
            ⛴ ${vessel}${porto !== "—" ? ` &nbsp;·&nbsp; Porto: ${porto}` : ""}${boatT ? ` &nbsp;·&nbsp; parte ${boatT.slice(0, 5)}` : ""}${connTime ? ` &nbsp;·&nbsp; <span style="color:#fdba74">${group[0]?.place_type === "airport" ? "✈️" : "🚂"} ${connTime.slice(0, 5)}</span>` : ""}
            <span style="font-weight:400;opacity:0.7;font-size:12px">&nbsp;— ${totalPax} pax</span>
            ${arrivalAtPorto && porto !== "—" ? `<div style="margin-top:5px;background:rgba(16,185,129,0.2);border-radius:4px;padding:4px 10px;font-size:12px;color:#6ee7b7;font-weight:700">🕐 Bruno si fa trovare alle ${arrivalAtPorto} a ${porto}</div>` : ""}
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="background:#f1f5f9">
                <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Cliente</th>
                <th style="padding:6px 10px;text-align:center;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Pax</th>
                <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Porto ritiro</th>
                <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Volo / Treno</th>
                <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Destinazione</th>
                <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border:1px solid #e2e8f0">Telefono / Note</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join("");

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<title>Liste Bruno — ${dateLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 12px; color: #1a1a1a; padding: 24px; background: #fff; }
  @media print {
    body { padding: 12px; }
    .no-print { display: none !important; }
    @page { margin: 1cm; size: A4 landscape; }
  }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;padding-bottom:12px;border-bottom:3px solid #0f172a">
    <div style="display:flex;align-items:center;gap:16px">
      <img src="/brand/logo-ischia-transfer.png" alt="Ischia Transfer" style="height:72px;width:auto" />
      <div>
        <h1 style="font-size:22px;font-weight:800;color:#0f172a;margin:0">Liste Bruno</h1>
        <div style="font-size:14px;color:#475569;margin-top:2px">${dateLabel}</div>
      </div>
    </div>
    <div style="text-align:right;font-size:12px;color:#64748b">
      <div>${arrivals.length} arrivi · ${departures.length} partenze</div>
      <div style="font-weight:700;color:#0f172a">${arrivals.length + departures.length} servizi totali · ${[...arrivals, ...departures].reduce((s, x) => s + x.pax, 0)} pax</div>
    </div>
  </div>

  ${arrivals.length > 0 ? `
  <h2 style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:10px;display:flex;align-items:center;gap:8px">
    📥 Arrivi da stazione / aeroporto <span style="font-size:12px;font-weight:400;color:#64748b">${arrivals.length} servizi</span>
  </h2>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;margin-bottom:28px">
    <thead>
      <tr style="background:#0f172a">
        <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Ora</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Cliente</th>
        <th style="padding:8px 10px;text-align:center;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Pax</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Provenienza</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Traghetto</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Hotel</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.7);border:1px solid #1e293b">Tel / Note</th>
      </tr>
    </thead>
    <tbody>${arrivalRows}</tbody>
  </table>` : ""}

  ${departures.length > 0 ? `
  <h2 style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:10px;display:flex;align-items:center;gap:8px">
    📤 Partenze verso stazione / aeroporto <span style="font-size:12px;font-weight:400;color:#64748b">${departures.length} servizi</span>
  </h2>
  ${departureSections}` : ""}

  <div class="no-print" style="margin-top:32px;text-align:center">
    <button onclick="window.print()" style="background:#0f172a;color:white;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Stampa / Salva PDF</button>
  </div>

  <div style="margin-top:24px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;text-align:center">
    Generato da Ischia Transfer Service PMS — ${new Date().toLocaleString("it-IT")}
  </div>
</body>
</html>`;
}

// ── Card singolo servizio ─────────────────────────────────────────────────────

type EditState = {
  place_type: PlaceType;
  meeting_point: string;
  porto_bruno: string;
  vessel: string;
};

function ServiceCard({
  svc,
  showTime = true,
  isDeparture = false,
  isEditing,
  editState,
  onEditStart,
  onEditChange,
  onEditSave,
  onEditCancel,
  saving,
}: {
  svc: BrunoService;
  showTime?: boolean;
  isDeparture?: boolean;
  isEditing: boolean;
  editState: EditState;
  onEditStart: () => void;
  onEditChange: (s: Partial<EditState>) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  saving: boolean;
}) {
  const portoBruno = svc.porto_bruno || portoDaVessel(svc.vessel) || null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-start gap-4 px-4 py-3">
        {showTime && (
          <div className="w-12 shrink-0 text-center">
            <span className="font-mono text-lg font-bold text-slate-800">{svc.time.slice(0, 5)}</span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold uppercase text-slate-900">{svc.customer_name}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{svc.pax} pax</span>
            <PlaceBadge type={svc.place_type} point={svc.meeting_point} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-slate-600">
            {isDeparture ? (
              <>
                <span className="font-mono font-bold text-slate-800">⏰ {svc.time.slice(0, 5)}</span>
                {svc.connection_time && (
                  <span className="font-semibold text-orange-700">
                    {svc.place_type === "airport" ? "✈️" : "🚂"} {svc.connection_time.slice(0, 5)}
                  </span>
                )}
                {svc.hotel_name && <span>🏨 {svc.hotel_name}</span>}
                {portoBruno && <span className="font-medium text-slate-700">⚓ {portoBruno}</span>}
                {svc.boat_t && <span className="font-medium text-emerald-700">⛴ {svc.boat_t.slice(0, 5)}</span>}
              </>
            ) : (
              svc.hotel_name && <span>🏨 {svc.hotel_name}</span>
            )}
            {!showTime && !isDeparture && <span>⏰ {svc.time.slice(0, 5)}</span>}
            <span>📞 {svc.phone}</span>
            {svc.notes && <span className="text-slate-400">{svc.notes}</span>}
          </div>
        </div>
        <button
          onClick={onEditStart}
          className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 hover:border-slate-300"
          title="Modifica"
        >
          ✏️
        </button>
      </div>

      {/* Form modifica inline */}
      {isEditing && (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-medium text-slate-600">
              Tipo luogo
              <select
                value={editState.place_type}
                onChange={(e) => onEditChange({ place_type: e.target.value as PlaceType })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
              >
                <option value="station">🚂 Stazione</option>
                <option value="airport">✈️ Aeroporto</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Punto incontro
              <input
                value={editState.meeting_point}
                onChange={(e) => onEditChange({ meeting_point: e.target.value })}
                placeholder={editState.place_type === "station" ? "es. Napoli Centrale" : "es. NAP T1"}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          {isDeparture && (
            <>
              <label className="text-xs font-medium text-slate-600">
                Traghetto (es. MEDMAR 08:10)
                <input
                  value={editState.vessel}
                  onChange={(e) => onEditChange({ vessel: e.target.value })}
                  placeholder="es. MEDMAR 08:10 · SNAV 07:10"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Porto ritiro Bruno
                <input
                  value={editState.porto_bruno}
                  onChange={(e) => onEditChange({ porto_bruno: e.target.value })}
                  placeholder="es. Pozzuoli / Napoli Beverello"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                />
              </label>
            </>
          )}
          <div className="flex gap-2">
            <button onClick={onEditCancel} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">
              Annulla
            </button>
            <button onClick={onEditSave} disabled={saving}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900 disabled:opacity-50">
              {saving ? "Salvataggio..." : "Salva"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab Arrivi ────────────────────────────────────────────────────────────────

function TabArrivi({
  arrivals, editingId, editState, saving,
  onEditStart, onEditChange, onEditSave, onEditCancel,
}: {
  arrivals: BrunoService[];
  editingId: string | null;
  editState: EditState;
  saving: boolean;
  onEditStart: (svc: BrunoService) => void;
  onEditChange: (s: Partial<EditState>) => void;
  onEditSave: (id: string) => void;
  onEditCancel: () => void;
}) {
  if (arrivals.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
        <p className="text-lg font-semibold">Nessun arrivo da stazione/aeroporto</p>
        <p className="mt-1 text-sm">I servizi con provenienza stazione o aeroporto appariranno qui.</p>
      </div>
    );
  }

  // Raggruppa per vessel (traghetto/volo)
  const byVessel = [...arrivals]
    .sort((a, b) => a.time.localeCompare(b.time))
    .reduce<Record<string, BrunoService[]>>((acc, a) => {
      (acc[a.vessel] ??= []).push(a);
      return acc;
    }, {});

  return (
    <div className="space-y-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {arrivals.length} servizi · Bruno ritira da stazione/aeroporto e porta al porto per l&apos;imbarco
      </p>
      {Object.entries(byVessel).map(([vessel, group]) => {
        const totalPax = group.reduce((s, a) => s + a.pax, 0);
        const arrivalIschia = group[0]?.arrival_at_ischia ?? null;
        return (
          <div key={vessel}>
            <div className="mb-2 rounded-xl bg-slate-700 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <span className="text-lg">⛴</span>
                <span className="font-bold text-white flex-1">{vessel}</span>
                <span className="rounded-full bg-slate-600 px-2.5 py-0.5 text-xs font-semibold text-slate-200">{totalPax} pax</span>
              </div>
              {arrivalIschia && (
                <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-blue-500/20 px-3 py-1.5">
                  <span className="text-blue-200 text-sm font-bold">🕐 Arriva a Ischia alle {arrivalIschia} · autista al porto per le {arrivalIschia}</span>
                </div>
              )}
            </div>
            <div className="space-y-2 pl-2">
              {group.map((svc) => (
                <ServiceCard
                  key={svc.id}
                  svc={svc}
                  showTime
                  isDeparture={false}
                  isEditing={editingId === svc.id}
                  editState={editState}
                  saving={saving}
                  onEditStart={() => onEditStart(svc)}
                  onEditChange={onEditChange}
                  onEditSave={() => onEditSave(svc.id)}
                  onEditCancel={onEditCancel}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab Partenze ──────────────────────────────────────────────────────────────

function TabPartenze({
  departures, editingId, editState, saving,
  onEditStart, onEditChange, onEditSave, onEditCancel,
}: {
  departures: BrunoService[];
  editingId: string | null;
  editState: EditState;
  saving: boolean;
  onEditStart: (svc: BrunoService) => void;
  onEditChange: (s: Partial<EditState>) => void;
  onEditSave: (id: string) => void;
  onEditCancel: () => void;
}) {
  if (departures.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
        <p className="text-lg font-semibold">Nessuna partenza verso stazione/aeroporto</p>
        <p className="mt-1 text-sm">I servizi con destinazione stazione o aeroporto appariranno qui, raggruppati per traghetto.</p>
      </div>
    );
  }

  const byVessel = departures.reduce<Record<string, BrunoService[]>>((acc, d) => {
    (acc[d.vessel] ??= []).push(d);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {departures.length} servizi · Bruno ritira al porto (Napoli/Pozzuoli) e porta a stazione/aeroporto
      </p>
      {Object.entries(byVessel)
        .sort(([a], [b]) => {
          const ta = departures.find((d) => d.vessel === a)?.time ?? "";
          const tb = departures.find((d) => d.vessel === b)?.time ?? "";
          return ta.localeCompare(tb);
        })
        .map(([vessel, group]) => {
          const totalPax = group.reduce((s, d) => s + d.pax, 0);
          const portoBrunoGroup = group[0]?.porto_bruno || portoDaVessel(vessel) || null;
          const boatTGroup = group.find(d => d.boat_t)?.boat_t ?? null;
          const arrivalGroup = group.find(d => d.arrival_at_porto)?.arrival_at_porto ?? null;
          const connTimeGroup = group.find(d => d.connection_time)?.connection_time ?? null;
          const connIcon = group[0]?.place_type === "airport" ? "✈️" : "🚂";
          return (
            <div key={vessel}>
              <div className="mb-2 rounded-xl bg-slate-800 px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="text-lg">⛴</span>
                  <div className="min-w-0 flex-1">
                    <span className="font-bold text-white">{vessel}</span>
                    {portoBrunoGroup && (
                      <span className="ml-2 text-sm text-slate-300">⚓ {portoBrunoGroup}</span>
                    )}
                    {boatTGroup && (
                      <span className="ml-2 text-sm text-slate-400">· parte {boatTGroup.slice(0, 5)}</span>
                    )}
                    {connTimeGroup && (
                      <span className="ml-2 text-sm font-semibold text-orange-300">· {connIcon} {connTimeGroup.slice(0, 5)}</span>
                    )}
                  </div>
                  <span className="rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-semibold text-slate-200">
                    {totalPax} pax
                  </span>
                </div>
                {arrivalGroup && portoBrunoGroup && (
                  <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-emerald-600/20 px-3 py-1.5">
                    <span className="text-emerald-300 text-sm font-bold">🕐 Bruno si fa trovare alle {arrivalGroup} a {portoBrunoGroup}</span>
                  </div>
                )}
              </div>
              <div className="space-y-2 pl-2">
                {group
                  .sort((a, b) => a.customer_name.localeCompare(b.customer_name))
                  .map((svc) => (
                    <ServiceCard
                      key={svc.id}
                      svc={svc}
                      showTime={false}
                      isDeparture
                      isEditing={editingId === svc.id}
                      editState={editState}
                      saving={saving}
                      onEditStart={() => onEditStart(svc)}
                      onEditChange={onEditChange}
                      onEditSave={() => onEditSave(svc.id)}
                      onEditCancel={onEditCancel}
                    />
                  ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────

type Tab = "arrivi" | "partenze";

export default function ListeBrunoPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [arrivals, setArrivals] = useState<BrunoService[]>([]);
  const [departures, setDepartures] = useState<BrunoService[]>([]);
  const [brunoEmail, setBrunoEmail] = useState("");
  const [savedBrunoEmail, setSavedBrunoEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("arrivi");
  const [showSendModal, setShowSendModal] = useState(false);
  const [senderNote, setSenderNote] = useState("");
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Modifica inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ place_type: "station", meeting_point: "", porto_bruno: "", vessel: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  // Aggiungi manuale per nome
  type SearchResult = { id: string; customer_name: string; pax: number; date: string; time: string; departure_date: string | null; departure_time: string | null; vessel: string; hotel_name: string | null };
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<SearchResult[]>([]);
  const [manualSearching, setManualSearching] = useState(false);
  const [manualAdding, setManualAdding] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);
    const res = await fetch(`/api/ops/liste-bruno?date=${d}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      setArrivals(body.arrivals ?? []);
      setDepartures(body.departures ?? []);
      const email = body.brunoEmail ?? "";
      setBrunoEmail(email);
      setSavedBrunoEmail(email);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(date); }, [load, date]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return null;
    const res = await fetch("/api/ops/liste-bruno", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, date, ...data }),
    });
    return res.json().catch(() => null);
  }, [date]);

  const handleSaveEmail = async () => {
    setSavingEmail(true);
    const body = await post("save_bruno_email", { bruno_email: brunoEmail });
    setSavingEmail(false);
    if (body?.ok) {
      setSavedBrunoEmail(brunoEmail);
      setMessage({ type: "ok", text: "Email di Bruno salvata." });
      setTimeout(() => setMessage(null), 3000);
    } else {
      setMessage({ type: "err", text: body?.error ?? "Errore salvataggio." });
    }
  };

  const handleSend = async () => {
    if (!brunoEmail.trim()) return;
    setSending(true);
    setMessage(null);
    const body = await post("send_email", { bruno_email: brunoEmail, sender_note: senderNote });
    setSending(false);
    if (body?.ok) {
      setShowSendModal(false);
      setSenderNote("");
      setMessage({ type: "ok", text: `Lista inviata a ${brunoEmail}` });
      setTimeout(() => setMessage(null), 5000);
    } else {
      setMessage({ type: "err", text: body?.error ?? "Errore invio." });
    }
  };

  // Modifica inline
  const handleEditStart = (svc: BrunoService) => {
    setEditingId(svc.id);
    setEditState({
      place_type: svc.place_type,
      meeting_point: svc.meeting_point ?? "",
      porto_bruno: svc.porto_bruno ?? "",
      vessel: svc.vessel ?? "",
    });
  };

  const handleEditSave = async (serviceId: string) => {
    setSavingEdit(true);
    const body = await post("set_place_type", {
      service_id: serviceId,
      place_type: editState.place_type,
      meeting_point: editState.meeting_point || null,
      porto_bruno: editState.porto_bruno || null,
      vessel: editState.vessel || null,
    });
    setSavingEdit(false);
    if (body?.ok) {
      setArrivals(body.arrivals ?? []);
      setDepartures(body.departures ?? []);
      setEditingId(null);
    } else {
      setMessage({ type: "err", text: body?.error ?? "Errore salvataggio." });
    }
  };

  const handleManualSearch = async (q: string) => {
    setManualQuery(q);
    setManualError(null);
    if (q.trim().length < 2) { setManualResults([]); return; }
    setManualSearching(true);
    const body = await post("search_services", { query: q });
    setManualSearching(false);
    setManualResults(body?.results ?? []);
  };

  const handleManualAdd = async (serviceId: string, placeType: PlaceType) => {
    setManualAdding(serviceId);
    setManualError(null);
    const body = await post("set_place_type", { service_id: serviceId, place_type: placeType });
    setManualAdding(null);
    if (body?.ok) {
      setArrivals(body.arrivals ?? []);
      setDepartures(body.departures ?? []);
      setManualResults([]);
      setManualQuery("");
    } else {
      setManualError(body?.error ?? "Errore.");
    }
  };

  const handlePrint = () => {
    const html = buildPrintHtml(date, arrivals, departures);
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(html);
      w.document.close();
      w.focus();
    }
  };

  const totalServices = arrivals.length + departures.length;
  const totalPax = [...arrivals, ...departures].reduce((s, svc) => s + svc.pax, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Liste Bruno"
        subtitle="Arrivi e partenze da stazione / aeroporto"
        actions={<img src="/brand/logo-ischia-transfer.png" alt="Ischia Transfer" className="h-16 w-auto" />}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <DateInput
          value={date}
          onChange={(iso) => setDate(iso)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
        />

        {!loading && totalServices > 0 && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
              {totalServices} servizi · {totalPax} pax
            </span>
            <span className="text-slate-300">|</span>
            <span className="text-xs">{arrivals.length} arrivi · {departures.length} partenze</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Stampa PDF */}
          {totalServices > 0 && (
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              title="Apri versione stampabile / salva PDF">
              🖨️ Stampa PDF
            </button>
          )}

          {/* Email Bruno */}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1">
            <span className="text-xs text-slate-500 shrink-0">Bruno:</span>
            <input
              value={brunoEmail}
              onChange={(e) => setBrunoEmail(e.target.value)}
              placeholder="email@esempio.it"
              type="email"
              className="w-44 border-0 bg-transparent text-xs text-slate-700 focus:outline-none"
            />
            {brunoEmail !== savedBrunoEmail && (
              <button
                onClick={() => void handleSaveEmail()}
                disabled={savingEmail}
                className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-slate-900 disabled:opacity-40">
                {savingEmail ? "..." : "Salva"}
              </button>
            )}
          </div>

          <button
            onClick={() => setShowSendModal(true)}
            disabled={totalServices === 0 || !brunoEmail.trim()}
            className="flex items-center gap-2 rounded-lg bg-pink-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!brunoEmail.trim() ? "Inserisci l'email di Bruno prima" : ""}>
            <span>✉️</span>
            Invia a Bruno
          </button>
        </div>
      </div>

      {/* Feedback */}
      {message && (
        <div className={`mx-6 mt-2 rounded-lg px-4 py-2 text-sm ${message.type === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
          {message.text}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 bg-white px-6">
        {([
          { key: "arrivi", label: "Arrivi", icon: "📥", count: arrivals.length },
          { key: "partenze", label: "Partenze", icon: "📤", count: departures.length },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-pink-500 text-pink-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}>
            <span>{tab.icon}</span>
            {tab.label}
            {tab.count > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                activeTab === tab.key ? "bg-pink-100 text-pink-700" : "bg-slate-100 text-slate-600"
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Aggiungi manuale per nome */}
      <div className="border-b border-slate-100 bg-slate-50 px-6 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 shrink-0">Aggiungi manuale:</span>
          <div className="relative">
            <input
              value={manualQuery}
              onChange={(e) => void handleManualSearch(e.target.value)}
              placeholder="Cerca per nome cliente..."
              className="w-64 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
            />
            {manualSearching && <span className="absolute right-2 top-1 text-xs text-slate-400">...</span>}
          </div>
          {manualError && <span className="text-xs text-rose-600">{manualError}</span>}
        </div>
        {manualResults.length > 0 && (
          <div className="mt-2 space-y-1">
            {manualResults.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
                <span className="font-semibold text-slate-800 uppercase">{r.customer_name}</span>
                <span className="text-slate-500">📥 {r.date.split("-").reverse().join("/")} {r.time}</span>
                {r.departure_date && <span className="text-slate-500">📤 {r.departure_date.split("-").reverse().join("/")} {r.departure_time ?? ""}</span>}
                <span className="text-slate-500">{r.hotel_name ?? r.vessel}</span>
                <span className="text-slate-400">{r.pax} pax</span>
                <div className="ml-auto flex gap-1">
                  <button
                    onClick={() => void handleManualAdd(r.id, "airport")}
                    disabled={manualAdding === r.id}
                    className="rounded bg-sky-600 px-2 py-0.5 text-white hover:bg-sky-700 disabled:opacity-40"
                  >
                    {manualAdding === r.id ? "..." : "✈️ Aeroporto"}
                  </button>
                  <button
                    onClick={() => void handleManualAdd(r.id, "station")}
                    disabled={manualAdding === r.id}
                    className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700 disabled:opacity-40"
                  >
                    {manualAdding === r.id ? "..." : "🚂 Stazione"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Contenuto */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="text-sm text-slate-500">Caricamento...</p>
        ) : activeTab === "arrivi" ? (
          <TabArrivi
            arrivals={arrivals}
            editingId={editingId}
            editState={editState}
            saving={savingEdit}
            onEditStart={handleEditStart}
            onEditChange={(s) => setEditState((prev) => ({ ...prev, ...s }))}
            onEditSave={handleEditSave}
            onEditCancel={() => setEditingId(null)}
          />
        ) : (
          <TabPartenze
            departures={departures}
            editingId={editingId}
            editState={editState}
            saving={savingEdit}
            onEditStart={handleEditStart}
            onEditChange={(s) => setEditState((prev) => ({ ...prev, ...s }))}
            onEditSave={handleEditSave}
            onEditCancel={() => setEditingId(null)}
          />
        )}
      </div>

      {/* Modal invio */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Invia lista a Bruno</h2>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-1 text-sm">
              <p className="font-medium text-slate-700">{fmtDateShort(date)}</p>
              <p className="text-slate-500">{arrivals.length} arrivi · {departures.length} partenze · {totalPax} pax totali</p>
              <p className="text-slate-500">Destinatario: <strong>{brunoEmail}</strong></p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Nota per Bruno (opzionale)
              </label>
              <textarea
                value={senderNote}
                onChange={(e) => setSenderNote(e.target.value)}
                placeholder="es. Attenzione: il volo FR 8542 ha 45 min di ritardo"
                rows={3}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowSendModal(false)}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button
                onClick={() => void handleSend()}
                disabled={sending}
                className="flex-1 rounded-lg bg-pink-600 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-40">
                {sending ? "Invio in corso..." : "✉️ Invia ora"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
