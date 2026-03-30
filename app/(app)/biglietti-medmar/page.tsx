"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel, Service } from "@/lib/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMedmarService(s: Service): boolean {
  return (s.vessel ?? "").toLowerCase().includes("medmar");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  const days = ["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return `${days[dow]} ${d} ${months[Number(m) - 1]} ${y}`;
}

function extractPratica(notes: string | null | undefined): string {
  const m = (notes ?? "").match(/\[practice:([^\]]+)\]/);
  return m?.[1] ?? "";
}

function normalizeCustomerKey(name: string, pratica: string): string {
  // Se c'è una pratica, usa quella come chiave primaria per evitare merge errati
  if (pratica) return pratica;
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

// ─── Tipi ────────────────────────────────────────────────────────────────────

type BookingGroup = {
  key: string;
  customerName: string;
  phone: string | null;
  pax: number;
  arrivo: Service | null;
  partenza: Service | null;
  hotel: string;
  pratica: string;
  refDate: string;
  allServiceIds: string[];
  sentAt: string | null; // medmar_ticket_sent_at del primo servizio
};

// ─── Componente ─────────────────────────────────────────────────────────────

export default function BigliettiMedmarPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(addDays(todayIso(), 14));
  const [copied, setCopied] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null); // key del gruppo in invio
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set());

  const handleCopy = (text: string, key: string) => {
    void copyText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    });
  };

  const loadData = useCallback(async (tid: string) => {
    if (!supabase) return;
    const [servicesRes, hotelsRes] = await Promise.all([
      supabase.from("services")
        .select("*, medmar_ticket_sent_at, medmar_ticket_sent_by")
        .eq("tenant_id", tid)
        .eq("is_draft", false)
        .gte("date", dateFrom)
        .lte("date", dateTo)
        .order("date")
        .order("time"),
      supabase.from("hotels").select("id, name").eq("tenant_id", tid).limit(500)
    ]);
    if (servicesRes.error) { setError(servicesRes.error.message); return; }
    setServices((servicesRes.data ?? []) as Service[]);
    setHotels((hotelsRes.data ?? []) as Hotel[]);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const session = await getClientSessionContext();
      if (!hasSupabaseEnv || !supabase || !session.userId || !session.tenantId) {
        if (active) { setError("Login richiesto."); setLoading(false); }
        return;
      }
      setTenantId(session.tenantId);
      setToken(session.accessToken ?? null);
      await loadData(session.tenantId);
      if (active) setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [loadData]);

  const hotelsById = useMemo(() => new Map(hotels.map((h) => [h.id, h])), [hotels]);

  const medmarServices = useMemo(() => services.filter(isMedmarService), [services]);

  // Raggruppa per pratica (o nome se non c'è pratica)
  const bookingGroups = useMemo((): BookingGroup[] => {
    const map = new Map<string, BookingGroup>();

    for (const s of medmarServices) {
      const pratica = extractPratica(s.notes);
      const key = normalizeCustomerKey(s.customer_name ?? "sconosciuto", pratica);
      const hotelName = hotelsById.get(s.hotel_id)?.name ?? "Hotel N/D";
      const isArrival =
        s.direction === "arrival" ||
        s.booking_service_kind === "transfer_port_hotel" ||
        (!s.direction && s.booking_service_kind == null);

      if (!map.has(key)) {
        map.set(key, {
          key,
          customerName: s.customer_name ?? "N/D",
          phone: s.phone && s.phone !== "N/D" ? s.phone : null,
          pax: s.pax ?? 1,
          arrivo: null,
          partenza: null,
          hotel: hotelName,
          pratica,
          refDate: s.date ?? "",
          allServiceIds: [],
          sentAt: (s as any).medmar_ticket_sent_at ?? null,
        });
      }

      const group = map.get(key)!;
      group.allServiceIds.push(s.id);

      if (s.phone && s.phone !== "N/D") group.phone = s.phone;

      if (isArrival) {
        if (!group.arrivo || (s.date ?? "") < (group.arrivo.date ?? "")) {
          group.arrivo = s;
        }
      } else {
        if (!group.partenza || (s.date ?? "") > (group.partenza.date ?? "")) {
          group.partenza = s;
        }
      }

      group.refDate = group.arrivo?.date ?? group.partenza?.date ?? s.date ?? "";
      group.hotel = hotelName;
      group.pax = Math.max(group.pax, s.pax ?? 1);
      // Se almeno un servizio è già inviato, considera il gruppo inviato
      if ((s as any).medmar_ticket_sent_at) group.sentAt = (s as any).medmar_ticket_sent_at;
    }

    return [...map.values()].sort((a, b) => a.refDate.localeCompare(b.refDate));
  }, [medmarServices, hotelsById]);

  const byDate = useMemo(() => {
    const map = new Map<string, BookingGroup[]>();
    for (const g of bookingGroups) {
      const k = g.refDate || "senza-data";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(g);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [bookingGroups]);

  const handleSend = async (g: BookingGroup) => {
    if (!token || sending) return;
    setSending(g.key);
    try {
      const res = await fetch("/api/services/medmar-send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ service_ids: g.allServiceIds })
      });
      const data = (await res.json()) as { ok: boolean; sent_to?: string | null; error?: string };
      if (data.ok) {
        setSentKeys((prev) => new Set([...prev, g.key]));
        if (tenantId) void loadData(tenantId);
        const msg = data.sent_to
          ? `Email inviata a ${data.sent_to}`
          : "Marcato come fatto (nessuna email agenzia configurata)";
        alert(msg);
      } else {
        alert(`Errore: ${data.error ?? "sconosciuto"}`);
      }
    } catch (e) {
      alert("Errore di rete");
    } finally {
      setSending(null);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Biglietti MEDMAR</h1>
          <p className="text-sm text-slate-500">Transfer via porto — arrivo e partenza per cliente, pronti per prenotazione</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
          <label className="text-xs font-medium text-slate-600">
            Dal
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value || todayIso())} className="ml-1 input-saas" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Al
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value || addDays(todayIso(), 14))} className="ml-1 input-saas" />
          </label>
        </div>
      </div>

      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {!loading && bookingGroups.length === 0 && (
        <div className="card p-6 text-center text-sm text-slate-500">
          Nessun biglietto MEDMAR nel periodo selezionato.
        </div>
      )}

      {byDate.map(([date, groups]) => (
        <div key={date} className="space-y-2">
          {/* Header data */}
          <div className="flex items-center gap-3 pb-1 border-b border-slate-200">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
              {formatDate(date)}
            </h2>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
              {groups.length} {groups.length === 1 ? "prenotazione" : "prenotazioni"} · {groups.reduce((s, g) => s + g.pax, 0)} pax
            </span>
            <button type="button"
              onClick={() => handleCopy(
                groups.map((g) =>
                  [g.customerName, `${g.pax} pax`, g.phone ?? "", g.hotel,
                   g.pratica ? `Pratica: ${g.pratica}` : "",
                   g.arrivo ? `Arrivo: ${g.arrivo.date} ${g.arrivo.time ?? ""}` : "",
                   g.partenza ? `Partenza: ${g.partenza.date} ${g.partenza.time ?? ""}` : ""
                  ].filter(Boolean).join(" | ")
                ).join("\n"),
                `all-${date}`
              )}
              className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
              {copied === `all-${date}` ? "✓ Copiato tutto" : "⎘ Copia tutti"}
            </button>
          </div>

          {/* Cards */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => {
              const isSent = g.sentAt != null || sentKeys.has(g.key);
              const isSending = sending === g.key;
              return (
                <div key={g.key} className={`card overflow-hidden ${isSent ? "ring-1 ring-emerald-300" : ""}`}>
                  {/* Header card */}
                  <div className="flex items-start justify-between gap-2 p-4 pb-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold text-slate-800 uppercase truncate">{g.customerName}</p>
                        {isSent && (
                          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                            ✓ Inviato
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">{g.hotel}</p>
                      {g.pratica && (
                        <p className="text-[11px] text-slate-400 font-mono">Pratica: {g.pratica}</p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">
                      {g.pax} pax
                    </span>
                  </div>

                  {/* Arrivo + Partenza */}
                  <div className="border-t border-slate-100 divide-y divide-slate-100">
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">A</div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-slate-700">
                          {g.arrivo ? `${formatDate(g.arrivo.date ?? "")} · ${g.arrivo.time ?? "orario N/D"}` : "—"}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {g.arrivo ? (g.arrivo.vessel ?? g.arrivo.booking_service_kind ?? "porto N/D") : "nessun arrivo"}
                        </p>
                      </div>
                      {g.arrivo && (
                        <button type="button"
                          onClick={() => handleCopy(`Arrivo ${g.arrivo!.date} ${g.arrivo!.time ?? ""}`, `arr-${g.key}`)}
                          className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50">
                          {copied === `arr-${g.key}` ? "✓" : "⎘"}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700">P</div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-slate-700">
                          {g.partenza ? `${formatDate(g.partenza.date ?? "")} · ${g.partenza.time ?? "orario N/D"}` : "—"}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {g.partenza ? (g.partenza.vessel ?? g.partenza.booking_service_kind ?? "porto N/D") : "nessuna partenza"}
                        </p>
                      </div>
                      {g.partenza && (
                        <button type="button"
                          onClick={() => handleCopy(`Partenza ${g.partenza!.date} ${g.partenza!.time ?? ""}`, `par-${g.key}`)}
                          className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50">
                          {copied === `par-${g.key}` ? "✓" : "⎘"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Bottoni copia */}
                  <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 flex flex-wrap gap-2">
                    <button type="button"
                      onClick={() => handleCopy(g.customerName, `nome-${g.key}`)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                      {copied === `nome-${g.key}` ? "✓ Nome" : "⎘ Nome"}
                    </button>
                    {g.phone && (
                      <button type="button"
                        onClick={() => handleCopy(g.phone!, `tel-${g.key}`)}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                        {copied === `tel-${g.key}` ? "✓" : "⎘"} {g.phone}
                      </button>
                    )}
                    <button type="button"
                      onClick={() => handleCopy("info@ischiatransferservice.it", `email-${g.key}`)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                      {copied === `email-${g.key}` ? "✓ Email" : "⎘ Email"}
                    </button>
                    <button type="button"
                      onClick={() => handleCopy(String(g.pax), `pax-${g.key}`)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                      {copied === `pax-${g.key}` ? "✓" : "⎘"} {g.pax} pax
                    </button>
                  </div>

                  {/* Bottone Fatto e invia */}
                  <div className="px-4 pb-4 pt-2">
                    {isSent ? (
                      <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                        <span className="text-xs text-emerald-700 font-semibold">✓ Email inviata all&apos;agenzia</span>
                        <button type="button"
                          onClick={() => void handleSend(g)}
                          className="ml-auto text-[10px] text-emerald-600 underline hover:no-underline">
                          Reinvia
                        </button>
                      </div>
                    ) : (
                      <button type="button"
                        disabled={isSending}
                        onClick={() => void handleSend(g)}
                        className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                        {isSending ? "Invio in corso..." : "✓ Fatto e invia all'agenzia"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
