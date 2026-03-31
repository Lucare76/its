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
  const [showSent, setShowSent] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sendModal, setSendModal] = useState<{ group: BookingGroup; pdfFile: File | null } | null>(null);

  const handleDelete = async (g: BookingGroup) => {
    if (!supabase || !tenantId) return;
    if (!confirm(`Eliminare la prenotazione di ${g.customerName}? L'operazione non è reversibile.`)) return;
    setDeleting(g.key);
    await supabase.from("services").delete().in("id", g.allServiceIds).eq("tenant_id", tenantId);
    setDeleting(null);
    if (tenantId) void loadData(tenantId, dateFrom, dateTo);
  };

  const handleCopy = (text: string, key: string) => {
    void copyText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    });
  };

  const loadData = useCallback(async (tid: string, from?: string, to?: string) => {
    if (!supabase) return;
    const qFrom = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? from! : todayIso();
    const qTo   = /^\d{4}-\d{2}-\d{2}$/.test(to ?? "")   ? to!   : addDays(todayIso(), 14);
    const [servicesRes, hotelsRes] = await Promise.all([
      supabase.from("services")
        .select("*, medmar_ticket_sent_at, medmar_ticket_sent_by")
        .eq("tenant_id", tid)
        .eq("is_draft", false)
        .gte("date", qFrom)
        .lte("date", qTo)
        .order("date")
        .order("time"),
      supabase.from("hotels").select("id, name").eq("tenant_id", tid).limit(500)
    ]);
    if (servicesRes.error) { setError(servicesRes.error.message); return; }
    setServices((servicesRes.data ?? []) as Service[]);
    setHotels((hotelsRes.data ?? []) as Hotel[]);
  }, []);

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
      await loadData(session.tenantId, dateFrom, dateTo);
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

  const visibleGroups = useMemo(
    () => showSent ? bookingGroups : bookingGroups.filter((g) => g.sentAt == null && !sentKeys.has(g.key)),
    [bookingGroups, showSent, sentKeys]
  );

  const byDate = useMemo(() => {
    const map = new Map<string, BookingGroup[]>();
    for (const g of visibleGroups) {
      const k = g.refDate || "senza-data";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(g);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleGroups]);

  const handleSend = async (g: BookingGroup, pdfFile: File | null) => {
    if (!token || sending) return;
    setSendModal(null);
    setSending(g.key);
    try {
      let pdf_base64: string | undefined;
      let pdf_filename: string | undefined;
      if (pdfFile) {
        const buf = await pdfFile.arrayBuffer();
        pdf_base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        pdf_filename = pdfFile.name;
      }
      const res = await fetch("/api/services/medmar-send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ service_ids: g.allServiceIds, pdf_base64, pdf_filename })
      });
      const data = (await res.json()) as { ok: boolean; sent_to?: string | null; error?: string };
      if (data.ok) {
        setSentKeys((prev) => new Set([...prev, g.key]));
        if (tenantId) void loadData(tenantId, dateFrom, dateTo);
        const msg = data.sent_to
          ? `Email inviata a ${data.sent_to}${pdfFile ? " con biglietto allegato" : ""}`
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
    <>
    <section className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Biglietti MEDMAR</h1>
          <p className="text-sm text-slate-500">Transfer via porto — arrivo e partenza per cliente, pronti per prenotazione</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
          <label className="text-xs font-medium text-slate-600">
            Dal
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="ml-1 input-saas" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Al
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="ml-1 input-saas" />
          </label>
          <button
            type="button"
            onClick={() => { if (tenantId) void loadData(tenantId, dateFrom, dateTo); }}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">
            Cerca
          </button>
          <button
            type="button"
            onClick={() => setShowSent((v) => !v)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${showSent ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>
            {showSent ? "✓ Inviati visibili" : "Mostra inviati"}
          </button>
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
                  {(() => {
                    // Partenza può venire da: servizio separato, oppure departure_date/return_time sul servizio arrivo
                    const partenzaDate = g.partenza?.date ?? g.arrivo?.departure_date ?? null;
                    const partenzaTime = g.partenza?.time ?? g.arrivo?.return_time ?? null;
                    const partenzaVessel = g.partenza?.vessel ?? g.arrivo?.vessel ?? "MEDMAR";
                    const hasPartenza = !!(partenzaDate || partenzaTime);
                    return (
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
                              {hasPartenza
                                ? `${partenzaDate ? formatDate(partenzaDate) : "data N/D"} · ${partenzaTime ?? "orario N/D"}`
                                : "—"}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {hasPartenza ? partenzaVessel : "nessuna partenza"}
                            </p>
                          </div>
                          {hasPartenza && (
                            <button type="button"
                              onClick={() => handleCopy(`Partenza ${partenzaDate ?? ""} ${partenzaTime ?? ""}`.trim(), `par-${g.key}`)}
                              className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50">
                              {copied === `par-${g.key}` ? "✓" : "⎘"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Bottoni copia — campi form MEDMAR (uno per campo) */}
                  {(() => {
                    // Split nome → cognome (tutto tranne prima parola) + nome (prima parola)
                    const nameParts = g.customerName.trim().split(/\s+/);
                    const nomeFirst = nameParts[0] ?? "";
                    const cognomeLast = nameParts.slice(1).join(" ");
                    const tel = g.phone ?? "";
                    const email = "info@ischiatransferservice.it";
                    return (
                      <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Copia campo per campo →</p>
                        <div className="flex flex-wrap gap-2">
                          {cognomeLast && (
                            <button type="button"
                              onClick={() => handleCopy(cognomeLast, `cgn-${g.key}`)}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                              {copied === `cgn-${g.key}` ? "✓" : "⎘"} Cognome
                            </button>
                          )}
                          <button type="button"
                            onClick={() => handleCopy(nomeFirst, `nome-${g.key}`)}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                            {copied === `nome-${g.key}` ? "✓" : "⎘"} Nome
                          </button>
                          {tel && (
                            <button type="button"
                              onClick={() => handleCopy(tel, `tel-${g.key}`)}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                              {copied === `tel-${g.key}` ? "✓" : "⎘"} {tel}
                            </button>
                          )}
                          <button type="button"
                            onClick={() => handleCopy(email, `email-${g.key}`)}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                            {copied === `email-${g.key}` ? "✓ Email" : "⎘ Email"}
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Bottone Fatto e invia + Elimina */}
                  <div className="px-4 pb-4 pt-2 space-y-2">
                    {isSent ? (
                      <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                        <span className="text-xs text-emerald-700 font-semibold">✓ Email inviata all&apos;agenzia</span>
                        <button type="button"
                          onClick={() => setSendModal({ group: g, pdfFile: null })}
                          className="ml-auto text-[10px] text-emerald-600 underline hover:no-underline">
                          Reinvia
                        </button>
                      </div>
                    ) : (
                      <button type="button"
                        disabled={isSending}
                        onClick={() => setSendModal({ group: g, pdfFile: null })}
                        className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                        {isSending ? "Invio in corso..." : "✓ Fatto e invia all'agenzia"}
                      </button>
                    )}
                    <button type="button"
                      disabled={deleting === g.key}
                      onClick={() => void handleDelete(g)}
                      className="w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed">
                      {deleting === g.key ? "Eliminazione..." : "Elimina prenotazione"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>

    {/* Modal invio con allegato PDF */}
    {sendModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Invia biglietto all&apos;agenzia</h2>
            <button type="button" onClick={() => setSendModal(null)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 space-y-0.5">
            <p className="text-sm font-semibold text-slate-800">{sendModal.group.customerName}</p>
            <p className="text-xs text-slate-500">{sendModal.group.hotel} · {sendModal.group.pax} pax</p>
            {sendModal.group.pratica && <p className="text-xs text-slate-400 font-mono">Pratica: {sendModal.group.pratica}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Allega biglietto MEDMAR (PDF)
            </label>
            <label className={`flex flex-col items-center justify-center w-full h-28 border-2 border-dashed rounded-xl cursor-pointer transition ${sendModal.pdfFile ? "border-emerald-400 bg-emerald-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}>
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setSendModal((prev) => prev ? { ...prev, pdfFile: f } : null);
                }}
              />
              {sendModal.pdfFile ? (
                <>
                  <span className="text-2xl">📎</span>
                  <span className="text-sm font-medium text-emerald-700 mt-1 max-w-[260px] truncate">{sendModal.pdfFile.name}</span>
                  <span className="text-xs text-emerald-600">Clicca per cambiare file</span>
                </>
              ) : (
                <>
                  <span className="text-2xl text-slate-400">📄</span>
                  <span className="text-sm text-slate-500 mt-1">Clicca per selezionare il PDF</span>
                  <span className="text-xs text-slate-400">oppure trascina qui</span>
                </>
              )}
            </label>
          </div>

          <div className="flex gap-2 pt-1">
            <button type="button"
              onClick={() => setSendModal(null)}
              className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Annulla
            </button>
            <button type="button"
              onClick={() => void handleSend(sendModal.group, sendModal.pdfFile)}
              disabled={!sendModal.pdfFile || sending === sendModal.group.key}
              className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">
              {sending === sendModal.group.key ? "Invio..." : "Invia con allegato"}
            </button>
          </div>

        </div>
      </div>
    )}
    </>
  );
}
