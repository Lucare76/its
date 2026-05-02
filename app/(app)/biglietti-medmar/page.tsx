"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { DateInput } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel, Service } from "@/lib/types";
import { getDepartureFerryLabel } from "@/lib/service-display";
import {
  MEDMAR_TICKET_ROUTE_LABELS,
  MEDMAR_TICKET_ROUTE_OPTIONS,
  formatSlotLabel,
  type MedmarTicketRouteCode,
} from "@/lib/medmar-ticket-memory";

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

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
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

type TicketMemoryRecord = {
  id: string;
  route_code: MedmarTicketRouteCode;
  travel_date: string;
  departure_time: string | null;
  issue_date: string | null;
  ticket_number: string | null;
  booking_code: string | null;
  voucher_label: string | null;
  tariff_label: string | null;
  price_cents: number | null;
  quantity: number;
  status: "available" | "matched" | "used" | "expired";
  matched_service_id: string | null;
  photo_path: string | null;
  photo_url: string | null;
  notes: string | null;
  created_at: string;
};

type TicketMemorySlot = {
  key: string;
  route_code: MedmarTicketRouteCode;
  travel_date: string;
  departure_time: string | null;
  available_quantity: number;
  tickets: TicketMemoryRecord[];
  matched_services: Array<{
    service_id: string;
    customer_name: string | null;
    hotel_name: string | null;
    pax: number | null;
    date: string;
    time: string | null;
    direction: "arrival" | "departure";
    vessel: string | null;
    score: number;
    reasons: string[];
  }>;
};

function formatEur(cents: number | null | undefined) {
  if (typeof cents !== "number") return "—";
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

async function apiFetch<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `Errore HTTP ${res.status}`);
  }
  return body;
}

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
  const [ticketMemories, setTicketMemories] = useState<TicketMemoryRecord[]>([]);
  const [ticketSlots, setTicketSlots] = useState<TicketMemorySlot[]>([]);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [memorySubmitting, setMemorySubmitting] = useState(false);
  const [memoryExtracting, setMemoryExtracting] = useState(false);
  const [memoryPhoto, setMemoryPhoto] = useState<File | null>(null);
  const [memoryRawText, setMemoryRawText] = useState("");
  const [memoryForm, setMemoryForm] = useState({
    route_code: "casamicciola_pozzuoli" as MedmarTicketRouteCode,
    travel_date: todayIso(),
    departure_time: "",
    issue_date: todayIso(),
    ticket_number: "",
    booking_code: "",
    voucher_label: "",
    tariff_label: "ADULTO - TARIFFA SPECIALE AR",
    price_eur: "10.25",
    quantity: "1",
    notes: "",
  });

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
        .neq("status", "cancelled")
        .neq("status", "pending_cancellation")
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

  const loadTicketMemory = useCallback(async (accessToken: string, from?: string, to?: string) => {
    const qFrom = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? from! : todayIso();
    const qTo = /^\d{4}-\d{2}-\d{2}$/.test(to ?? "") ? to! : addDays(todayIso(), 14);
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const params = new URLSearchParams({ date_from: qFrom, date_to: qTo });
      const data = await apiFetch<{ memories: TicketMemoryRecord[]; slots: TicketMemorySlot[] }>(
        `/api/medmar-ticket-memory?${params.toString()}`,
        accessToken,
      );
      setTicketMemories(data.memories);
      setTicketSlots(data.slots);
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Errore caricamento memoria ticket.");
    } finally {
      setMemoryLoading(false);
    }
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
      if (session.accessToken) await loadTicketMemory(session.accessToken, dateFrom, dateTo);
      if (active) setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [dateFrom, dateTo, loadData, loadTicketMemory]);

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
          sentAt: s.medmar_ticket_sent_at ?? null,
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
      if (s.medmar_ticket_sent_at) group.sentAt = s.medmar_ticket_sent_at;
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

  const activeTicketSlots = useMemo(
    () => ticketSlots.filter((slot) => slot.available_quantity > 0),
    [ticketSlots],
  );

  const expiredMemoryCount = useMemo(
    () => ticketMemories.filter((ticket) => ticket.status === "expired").length,
    [ticketMemories],
  );

  const handleExtractMemoryFromPhoto = async () => {
    if (!token || !memoryPhoto) {
      setMemoryError("Carica prima la foto del biglietto.");
      return;
    }
    setMemoryExtracting(true);
    setMemoryError(null);
    try {
      const imageBase64 = await fileToBase64(memoryPhoto);
      const data = await apiFetch<{
        extracted: {
          route_code: MedmarTicketRouteCode | null;
          travel_date: string | null;
          departure_time: string | null;
          issue_date: string | null;
          ticket_number: string | null;
          booking_code: string | null;
          voucher_label: string | null;
          tariff_label: string | null;
          price_cents: number | null;
          quantity: number | null;
          raw_text: string;
        };
      }>(
        "/api/medmar-ticket-memory/extract",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            image_base64: imageBase64,
            mime_type: memoryPhoto.type || "image/jpeg",
          }),
        },
      );

      setMemoryRawText(data.extracted.raw_text || "");
      setMemoryForm((prev) => ({
        ...prev,
        route_code: data.extracted.route_code ?? prev.route_code,
        travel_date: data.extracted.travel_date ?? prev.travel_date,
        departure_time: data.extracted.departure_time ?? prev.departure_time,
        issue_date: data.extracted.issue_date ?? prev.issue_date,
        ticket_number: data.extracted.ticket_number ?? prev.ticket_number,
        booking_code: data.extracted.booking_code ?? prev.booking_code,
        voucher_label: data.extracted.voucher_label ?? prev.voucher_label,
        tariff_label: data.extracted.tariff_label ?? prev.tariff_label,
        price_eur: typeof data.extracted.price_cents === "number"
          ? (data.extracted.price_cents / 100).toFixed(2)
          : prev.price_eur,
        quantity: data.extracted.quantity ? String(data.extracted.quantity) : prev.quantity,
      }));
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Errore lettura foto ticket.");
    } finally {
      setMemoryExtracting(false);
    }
  };

  const handleMemorySubmit = async () => {
    if (!supabase || !tenantId || !token) return;
    if (!memoryPhoto) {
      setMemoryError("Carica la foto del biglietto.");
      return;
    }
    setMemorySubmitting(true);
    setMemoryError(null);
    try {
      const safeName = memoryPhoto.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const storagePath = `medmar-ticket-memory/${tenantId}/${Date.now()}-${safeName}`;
      const upload = await supabase.storage.from("service-photos").upload(storagePath, memoryPhoto, {
        contentType: memoryPhoto.type,
        upsert: false,
      });
      if (upload.error) throw new Error(upload.error.message);
      const photoUrl = supabase.storage.from("service-photos").getPublicUrl(storagePath).data.publicUrl;
      const priceFloat = Number(memoryForm.price_eur.replace(",", "."));
      await apiFetch(
        "/api/medmar-ticket-memory",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            route_code: memoryForm.route_code,
            travel_date: memoryForm.travel_date,
            departure_time: memoryForm.departure_time || null,
            issue_date: memoryForm.issue_date || null,
            ticket_number: memoryForm.ticket_number || null,
            booking_code: memoryForm.booking_code || null,
            voucher_label: memoryForm.voucher_label || null,
            tariff_label: memoryForm.tariff_label || null,
            price_cents: Number.isFinite(priceFloat) ? Math.round(priceFloat * 100) : null,
            quantity: Math.max(1, Number(memoryForm.quantity) || 1),
            notes: memoryForm.notes || null,
            photo_path: storagePath,
            photo_url: photoUrl,
          }),
        },
      );
      await loadTicketMemory(token, dateFrom, dateTo);
      setMemoryModalOpen(false);
      setMemoryPhoto(null);
      setMemoryRawText("");
      setMemoryForm({
        route_code: "casamicciola_pozzuoli",
        travel_date: todayIso(),
        departure_time: "",
        issue_date: todayIso(),
        ticket_number: "",
        booking_code: "",
        voucher_label: "",
        tariff_label: "ADULTO - TARIFFA SPECIALE AR",
        price_eur: "10.25",
        quantity: "1",
        notes: "",
      });
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Errore salvataggio ticket.");
    } finally {
      setMemorySubmitting(false);
    }
  };

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
            <DateInput value={dateFrom} onChange={(iso) => setDateFrom(iso)} className="ml-1 input-saas" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Al
            <DateInput value={dateTo} onChange={(iso) => setDateTo(iso)} className="ml-1 input-saas" />
          </label>
          <button
            type="button"
            onClick={() => {
              if (tenantId) void loadData(tenantId, dateFrom, dateTo);
              if (token) void loadTicketMemory(token, dateFrom, dateTo);
            }}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">
            Cerca
          </button>
          <button
            type="button"
            onClick={() => setMemoryModalOpen(true)}
            className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100">
            + Memorizza ticket da foto
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

      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-indigo-900">Memoria ticket da foto</h2>
            <p className="text-xs text-indigo-700">
              Archivia il biglietto fotografato e verifica subito se nel DB esistono arrivi o partenze compatibili.
            </p>
          </div>
          <div className="rounded-xl bg-white/80 px-3 py-2 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Disponibilità attiva</p>
            <p className="text-lg font-extrabold text-slate-900">
              {activeTicketSlots.reduce((sum, slot) => sum + slot.available_quantity, 0)} biglietti
            </p>
            <p className="text-[11px] text-slate-500">
              Storico scaduti: {expiredMemoryCount}
            </p>
          </div>
        </div>

        {memoryLoading && <p className="text-sm text-slate-500">Controllo ticket disponibili...</p>}
        {memoryError && <p className="text-sm text-rose-600">{memoryError}</p>}

        {!memoryLoading && activeTicketSlots.length === 0 && (
          <div className="rounded-xl border border-dashed border-indigo-200 bg-white/70 p-4 text-sm text-slate-500">
            Nessun ticket disponibile memorizzato nel periodo selezionato.
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          {activeTicketSlots.map((slot) => (
            <div key={slot.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-900">
                    {formatSlotLabel({
                      routeCode: slot.route_code,
                      travelDate: slot.travel_date,
                      departureTime: slot.departure_time,
                    })}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {slot.tickets.length} memori{slot.tickets.length === 1 ? "a" : "e"} · {slot.available_quantity} posti ticket disponibili
                  </p>
                </div>
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
                  {slot.available_quantity} disp.
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {slot.tickets.map((ticket) => (
                  <a
                    key={ticket.id}
                    href={ticket.photo_url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                  >
                    {ticket.ticket_number ?? "Ticket"} · {formatEur(ticket.price_cents)}
                  </a>
                ))}
              </div>

              {slot.matched_services.length > 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    {slot.available_quantity} bigliett{slot.available_quantity === 1 ? "o" : "i"} disponibili per questa corsa
                  </p>
                  <p className="text-sm font-semibold text-slate-800">
                    Potresti abbinarl{slot.available_quantity === 1 ? "o" : "i"} a:
                  </p>
                  <div className="space-y-2">
                    {slot.matched_services.slice(0, 5).map((service) => (
                      <div key={service.service_id} className="rounded-lg bg-white px-3 py-2 border border-amber-100">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-slate-900">{service.customer_name ?? "Cliente N/D"}</p>
                          <span className="text-[10px] font-bold text-amber-700">score {service.score}</span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {service.pax ?? "?"} pax
                          {service.hotel_name ? ` · ${service.hotel_name}` : ""}
                          {service.time ? ` · ${service.time}` : ""}
                        </p>
                        <p className="text-[11px] text-slate-400">{service.vessel ?? "Vessel N/D"}</p>
                        <p className="text-[10px] text-amber-700">{service.reasons.join(" · ")}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  Nessun servizio Medmar compatibile trovato nel DB per questa corsa nel periodo selezionato.
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

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
                   (() => {
                     const pd = g.partenza?.date ?? g.arrivo?.departure_date ?? null;
                     const pt = g.partenza?.time ?? g.arrivo?.departure_time ?? g.arrivo?.return_time ?? null;
                     return (pd || pt) ? `Partenza: ${pd ?? ""} ${pt ?? ""}`.trim() : "";
                   })()
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
                    // Per servizi formula (SNAV/MEDMAR), mostra orario traghetto da Ischia (orario_barca), non il pickup hotel
                    const ferrySource = g.partenza ?? g.arrivo ?? null;
                    const departureFerryLabel = ferrySource ? getDepartureFerryLabel(ferrySource) : null;
                    const partenzaTime = g.partenza?.orario_barca?.slice(0, 5)
                      ?? g.partenza?.time
                      ?? g.arrivo?.departure_time
                      ?? g.arrivo?.return_time
                      ?? null;
                    const partenzaVessel = departureFerryLabel ?? g.partenza?.vessel ?? "MEDMAR";
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
                    // Formato per bookmarklet: COGNOME\tNOME\tTEL\tEMAIL
                    const medmarClipboard = [cognomeLast || nomeFirst, cognomeLast ? nomeFirst : "", tel, email].join("\t");
                    return (
                      <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-2">
                        <button type="button"
                          onClick={() => handleCopy(medmarClipboard, `medmar-${g.key}`)}
                          className="w-full rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 text-center">
                          {copied === `medmar-${g.key}` ? "✓ Pronto! Vai su MEDMAR e clicca il bookmark" : "⎘ Copia per MEDMAR (usa con bookmark)"}
                        </button>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">oppure campo per campo →</p>
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
    {memoryModalOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Memorizza ticket Medmar da foto</h2>
            <button type="button" onClick={() => setMemoryModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
          </div>

          <p className="text-sm text-slate-500">
            La foto viene archiviata, il ticket viene letto con OCR classico e poi indicizzato per corsa. Se la data passa, sparisce dalla disponibilità attiva ma resta nello storico.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Foto biglietto *
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  setMemoryPhoto(event.target.files?.[0] ?? null);
                  setMemoryRawText("");
                  setMemoryError(null);
                }}
                className="mt-1 block w-full text-sm"
              />
            </label>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleExtractMemoryFromPhoto()}
                disabled={!memoryPhoto || memoryExtracting}
                className="rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {memoryExtracting ? "Lettura foto..." : "Leggi dati dalla foto"}
              </button>
              <p className="text-xs text-slate-500">
                Nessuna AI generativa: OCR standard + parser dedicato al formato Medmar.
              </p>
            </div>
            <label className="text-xs font-medium text-slate-600">
              Corsa *
              <select
                value={memoryForm.route_code}
                onChange={(event) => setMemoryForm((prev) => ({ ...prev, route_code: event.target.value as MedmarTicketRouteCode }))}
                className="mt-1 input-saas w-full"
              >
                {MEDMAR_TICKET_ROUTE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Data corsa *
              <DateInput value={memoryForm.travel_date} onChange={(value) => setMemoryForm((prev) => ({ ...prev, travel_date: value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Orario corsa
              <input type="time" value={memoryForm.departure_time} onChange={(event) => setMemoryForm((prev) => ({ ...prev, departure_time: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Data emissione
              <DateInput value={memoryForm.issue_date} onChange={(value) => setMemoryForm((prev) => ({ ...prev, issue_date: value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              N. biglietto
              <input value={memoryForm.ticket_number} onChange={(event) => setMemoryForm((prev) => ({ ...prev, ticket_number: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Booking Medmar
              <input value={memoryForm.booking_code} onChange={(event) => setMemoryForm((prev) => ({ ...prev, booking_code: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Voucher
              <input value={memoryForm.voucher_label} onChange={(event) => setMemoryForm((prev) => ({ ...prev, voucher_label: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Prezzo €
              <input value={memoryForm.price_eur} onChange={(event) => setMemoryForm((prev) => ({ ...prev, price_eur: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Quantità ticket
              <input type="number" min="1" value={memoryForm.quantity} onChange={(event) => setMemoryForm((prev) => ({ ...prev, quantity: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Tariffa
              <input value={memoryForm.tariff_label} onChange={(event) => setMemoryForm((prev) => ({ ...prev, tariff_label: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Note
              <textarea value={memoryForm.notes} onChange={(event) => setMemoryForm((prev) => ({ ...prev, notes: event.target.value }))} rows={3} className="mt-1 input-saas w-full resize-none" />
            </label>
            {memoryRawText && (
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Testo letto dalla foto
                <textarea value={memoryRawText} readOnly rows={6} className="mt-1 input-saas w-full resize-y bg-slate-50 text-[11px]" />
              </label>
            )}
          </div>

          {memoryError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{memoryError}</p>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setMemoryModalOpen(false)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Annulla
            </button>
            <button type="button" onClick={() => void handleMemorySubmit()} disabled={memorySubmitting} className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              {memorySubmitting ? "Salvataggio..." : "Salva ticket in memoria"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
