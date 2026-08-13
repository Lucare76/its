"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DateInput, PageHeader } from "@/components/ui";
import { WhatsAppButton } from "@/components/whatsapp-button";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

type ServiceRow = {
  id: string;
  customer_name: string | null;
  phone: string | null;
  phone_e164: string | null;
  pax: number | null;
  time: string | null;
  notes: string | null;
  hotel_id: string | null;
  agency_id: string | null;
  billing_party_name: string | null;
  place_type: string | null;
  meeting_point: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  orario_barca: string | null;
  pickup_time: string | null;
  linked_service_id: string | null;
  transport_code: string | null;
  direction: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  reminder_status?: string | null;
  sent_at?: string | null;
  internal_notes?: string | null;
  internal_notes_updated_at?: string | null;
  internal_notes_updated_by?: string | null;
};
type HotelRow = { id: string; name: string };
type AgencyRow = { id: string; name: string };
type BookingQrRow = {
  id: string;
  direction: "outbound" | "return";
  service_date: string;
  qr_token: string;
  qr_payload: string;
  qr_image_url: string;
  status: "active" | "used" | "cancelled";
  used_at: string | null;
};
type BookingQrSummary = {
  bookingId: string;
  customerName: string;
  phone: string | null;
  codes: BookingQrRow[];
};

function isValidTime(t: string) {
  return /^\d{2}:\d{2}$/.test(t.trim());
}

export default function ServiceEditPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);

  const [service, setService] = useState<ServiceRow | null>(null);
  const [hotels, setHotels] = useState<HotelRow[]>([]);
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);

  // Form fields
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [pax, setPax] = useState("1");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [meetingPoint, setMeetingPoint] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [arrivalTime, setArrivalTime] = useState("");
  const [departureDate, setDepartureDate] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  const [transportCode, setTransportCode] = useState("");
  const [outboundFerryDeparture, setOutboundFerryDeparture] = useState("");
  const [outboundFerryArrival, setOutboundFerryArrival] = useState("");
  const [returnPickup, setReturnPickup] = useState("");
  const [returnFerryDeparture, setReturnFerryDeparture] = useState("");

  const [internalNotes, setInternalNotes] = useState("");
  const [internalNotesSaving, setInternalNotesSaving] = useState(false);
  const [internalNotesUpdatedAt, setInternalNotesUpdatedAt] = useState<string | null>(null);
  const internalNotesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [qrSummary, setQrSummary] = useState<BookingQrSummary | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrMessage, setQrMessage] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState<"generate" | "pdf" | "whatsapp" | null>(null);
  const [whatsAppBusy, setWhatsAppBusy] = useState(false);
  const [whatsAppMessage, setWhatsAppMessage] = useState<string | null>(null);

  // Inline hotel creation
  const [addingHotel, setAddingHotel] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [savingHotel, setSavingHotel] = useState(false);

  const isBusBooking = service?.booking_service_kind === "bus_city_hotel" || service?.service_type_code === "bus_line";
  const isFerryFormula = service?.booking_service_kind === "formula_snav"
    || service?.booking_service_kind === "formula_medmar_napoli"
    || service?.booking_service_kind === "formula_medmar_pozzuoli";

  async function loadBusQr(serviceId: string, token: string) {
    setQrLoading(true);
    setQrMessage(null);
    const res = await fetch(`/api/bookings/${serviceId}/qr-codes`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null) as (BookingQrSummary & { error?: string }) | null;
    setQrLoading(false);
    if (!res.ok || !body) {
      setQrSummary(null);
      setQrMessage(body?.error ?? "QR bus non disponibili.");
      return;
    }
    setQrSummary({
      bookingId: body.bookingId,
      customerName: body.customerName,
      phone: body.phone,
      codes: body.codes,
    });
  }

  async function regenerateBusQr() {
    if (!service?.id || !accessToken) return;
    setQrBusy("generate");
    setQrMessage(null);
    const res = await fetch(`/api/bookings/${service.id}/qr-codes/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ force: true }),
    });
    const body = await res.json().catch(() => null) as (BookingQrSummary & { error?: string }) | null;
    setQrBusy(null);
    if (!res.ok || !body) {
      setQrMessage(body?.error ?? "Rigenerazione QR non riuscita.");
      return;
    }
    setQrSummary({
      bookingId: body.bookingId,
      customerName: body.customerName,
      phone: body.phone,
      codes: body.codes,
    });
    setQrMessage("QR bus rigenerati con successo.");
  }

  async function openBusQrPdf() {
    if (!service?.id || !accessToken) return;
    setQrBusy("pdf");
    setQrMessage(null);
    const res = await fetch(`/api/bookings/${service.id}/qr-codes/pdf`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const html = await res.text();
    setQrBusy(null);
    if (!res.ok) {
      setQrMessage("PDF QR bus non disponibile.");
      return;
    }
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) {
      setQrMessage("Consenti i popup del browser per aprire il PDF.");
      return;
    }
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }

  async function sendBusQrWhatsApp(selection: "outbound" | "return" | "both") {
    if (!service?.id || !accessToken) return;
    setQrBusy("whatsapp");
    setQrMessage(null);
    const res = await fetch(`/api/bookings/${service.id}/qr-codes/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ selection, media_kind: "image" }),
    });
    const body = await res.json().catch(() => null) as { errors?: string[]; preview_only?: boolean } | null;
    setQrBusy(null);
    if (!res.ok) {
      setQrMessage(body?.errors?.[0] ?? "Invio WhatsApp non riuscito.");
      return;
    }
    setQrMessage(body?.preview_only
      ? "Payload WhatsApp pronto. Mancano le credenziali/template live oppure e attiva la modalita anteprima."
      : "Invio WhatsApp eseguito.");
  }

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase || !session.tenantId) {
        setInitError("Sessione non disponibile.");
        setLoading(false);
        return;
      }
      if (session.role !== "admin" && session.role !== "operator") {
        setInitError("Ruolo non autorizzato.");
        setLoading(false);
        return;
      }
      setTenantId(session.tenantId);
      const sessionData = await supabase.auth.getSession();
      const token = sessionData.data.session?.access_token ?? null;
      setAccessToken(token);
      if (!token) {
        setInitError("Sessione non valida.");
        setLoading(false);
        return;
      }

      const response = await fetch(`/api/ops/services/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as {
        service?: ServiceRow;
        linked_service?: Partial<ServiceRow> | null;
        hotels?: HotelRow[];
        agencies?: AgencyRow[];
        error?: string;
      } | null;

      if (!active) return;
      if (!response.ok || !body?.service) {
        setInitError(body?.error ?? "Servizio non trovato.");
        setLoading(false);
        return;
      }

      const svc = body.service;
      setService(svc);
      setHotels(body.hotels ?? []);
      setAgencies(body.agencies ?? []);

      setCustomerName(svc.customer_name ?? "");
      setPhone(svc.phone ?? "");
      setPax(String(svc.pax ?? 1));
      setTime((svc.time ?? "").slice(0, 5));
      setNotes(svc.notes ?? "");
      setHotelId(svc.hotel_id ?? "");
      setAgencyId(svc.agency_id ?? "");
      setMeetingPoint(svc.meeting_point ?? "");
      setArrivalDate(svc.arrival_date ?? "");
      const ferryFormula = svc.booking_service_kind === "formula_snav"
        || svc.booking_service_kind === "formula_medmar_napoli"
        || svc.booking_service_kind === "formula_medmar_pozzuoli";
      setArrivalTime(((ferryFormula ? svc.time : svc.arrival_time) ?? "").slice(0, 5));
      setDepartureDate(svc.departure_date ?? "");
      setDepartureTime(((ferryFormula ? svc.orario_barca : svc.departure_time) ?? "").slice(0, 5));
      const linked = body.linked_service ?? null;
      const arrivalLeg = svc.direction === "arrival" ? svc : linked?.direction === "arrival" ? linked : svc;
      const departureLeg = svc.direction === "departure" ? svc : linked?.direction === "departure" ? linked : null;
      setOutboundFerryDeparture((arrivalLeg.time ?? "").slice(0, 5));
      setOutboundFerryArrival((arrivalLeg.arrival_time ?? "").slice(0, 5));
      setReturnPickup(((departureLeg?.pickup_time ?? departureLeg?.departure_time) ?? "").slice(0, 5));
      setReturnFerryDeparture((departureLeg?.orario_barca ?? "").slice(0, 5));
      setTransportCode(svc.transport_code ?? "");
      setInternalNotes(svc.internal_notes ?? "");
      setInternalNotesUpdatedAt(svc.internal_notes_updated_at ?? null);

      if (token && (svc.booking_service_kind === "bus_city_hotel" || svc.service_type_code === "bus_line")) {
        await loadBusQr(svc.id, token);
      }

      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [id]);

  const createHotel = async () => {
    if (!supabase || !tenantId || !newHotelName.trim()) return;
    setSavingHotel(true);
    const { data, error: err } = await supabase
      .from("hotels")
      .insert({ name: newHotelName.trim(), tenant_id: tenantId, address: "", lat: 0, lng: 0, zone: "" })
      .select("id, name")
      .single();
    setSavingHotel(false);
    if (err || !data) { setError(err?.message ?? "Errore creazione hotel."); return; }
    setHotels((prev) => [...prev, data as HotelRow].sort((a, b) => a.name.localeCompare(b.name, "it")));
    setHotelId((data as HotelRow).id);
    setAddingHotel(false);
    setNewHotelName("");
  };

  const save = async () => {
    if (!tenantId || !service || !accessToken) return;
    if (time && !isValidTime(time)) { setError("Inserisci un orario valido nel formato HH:MM."); return; }
    setSaving(true);
    setError(null);
    const selectedAgency = agencies.find((a) => a.id === agencyId);
    const response = await fetch(`/api/ops/services/${service.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        customer_name: customerName,
        phone: phone.trim() || null,
        pax: Number(pax) || 1,
        ...(!isFerryFormula ? { time: time.trim() || null } : {}),
        notes: notes.trim() || null,
        hotel_id: hotelId || null,
        agency_id: agencyId || null,
        billing_party_name: selectedAgency?.name ?? null,
        meeting_point: meetingPoint.trim() || null,
        arrival_date: arrivalDate || null,
        ...(isFerryFormula ? {} : { arrival_time: arrivalTime || null }),
        departure_date: departureDate || null,
        ...(!isFerryFormula ? { departure_time: departureTime || null } : {}),
        transport_code: transportCode.trim() || null,
        ...(isFerryFormula ? {
          outbound_ferry_departure_time: outboundFerryDeparture || null,
          outbound_ferry_arrival_time: outboundFerryArrival || null,
          return_pickup_time: returnPickup || null,
          return_ferry_departure_time: returnFerryDeparture || null,
        } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setSaving(false);
    if (!response.ok) { setError(body?.error ?? "Salvataggio non riuscito."); return; }
    if (accessToken && phone.trim()) {
      void fetch("/api/ops/whatsapp-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ phone: phone.trim(), name: customerName.trim(), tenantId }),
      }).catch(() => {});
    }
    setSaved(true);
    setTimeout(() => router.back(), 1200);
  };

  const sendWhatsAppReminder = async () => {
    if (!service?.id || !accessToken) return;
    setWhatsAppBusy(true);
    setWhatsAppMessage(null);
    const response = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ service_id: service.id })
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; sent_at?: string } | null;
    setWhatsAppBusy(false);
    if (!response.ok || !body?.ok) {
      setWhatsAppMessage(body?.error ?? "Invio WhatsApp non riuscito.");
      return;
    }
    setWhatsAppMessage("Messaggio WhatsApp inviato.");
    setService((current) => current ? { ...current, reminder_status: "sent", sent_at: body.sent_at ?? new Date().toISOString() } : current);
  };

  function handleInternalNotesChange(value: string) {
    setInternalNotes(value);
    if (internalNotesDebounce.current) clearTimeout(internalNotesDebounce.current);
    internalNotesDebounce.current = setTimeout(() => void saveInternalNotes(value), 2000);
  }

  async function saveInternalNotes(value: string) {
    if (!service?.id || !accessToken) return;
    setInternalNotesSaving(true);
    const res = await fetch(`/api/ops/services/${service.id}/internal-notes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ internal_notes: value.trim() || null }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; updated_at?: string } | null;
    setInternalNotesSaving(false);
    if (body?.updated_at) setInternalNotesUpdatedAt(body.updated_at);
  }

  if (loading) return (
    <section className="page-section">
      <p className="text-sm text-slate-500">Caricamento...</p>
    </section>
  );

  if (initError) return (
    <section className="page-section">
      <p className="text-sm text-rose-600">{initError}</p>
    </section>
  );

  if (!service) return null;

  return (
    <section className="page-section">
      <PageHeader
        title="Modifica servizio"
        subtitle={service.customer_name ?? ""}
        breadcrumbs={[{ label: "Cruscotto", href: "/dashboard" }, { label: "Modifica servizio" }]}
      />

      <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}
        {saved && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">✓ Salvato</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Hotel */}
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-600">Hotel</span>
              <button type="button" onClick={() => setAddingHotel((v) => !v)} className="text-xs text-indigo-600 hover:text-indigo-800">
                {addingHotel ? "Annulla" : "+ Nuovo hotel"}
              </button>
            </div>
            {addingHotel ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newHotelName}
                  onChange={(e) => setNewHotelName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createHotel(); }}
                  placeholder="Nome hotel..."
                  className="input-saas flex-1"
                />
                <button type="button" onClick={() => void createHotel()} disabled={savingHotel || !newHotelName.trim()} className="btn-primary px-3 py-1.5 text-sm disabled:opacity-50">
                  {savingHotel ? "..." : "Crea"}
                </button>
              </div>
            ) : (
              <select value={hotelId} onChange={(e) => setHotelId(e.target.value)} className="input-saas w-full">
                <option value="">— Nessun hotel —</option>
                {hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            )}
          </div>

          {/* Nome cliente */}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Nome cliente
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="mt-1 input-saas w-full" />
          </label>

          {/* Pax + Orario */}
          <label className="text-xs font-medium text-slate-600">
            Pax
            <input type="number" min="1" max="99" value={pax} onChange={(e) => setPax(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          {!isFerryFormula ? <label className="text-xs font-medium text-slate-600">
            Orario
            <input type="time" step="300" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 input-saas w-full" />
          </label> : null}

          {/* Telefono */}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            <span className="flex items-center gap-2">
              Telefono
              <WhatsAppButton phone={phone} name={customerName} tenantId={tenantId} />
            </span>
            <input
              autoFocus={!service.phone}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+39 333 1234567"
              className={`mt-1 input-saas w-full ${!service.phone ? "ring-2 ring-amber-400" : ""}`}
            />
          </label>

          {/* Date prenotazione */}
          <div className="sm:col-span-2">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Date prenotazione</p>
            <div className="grid grid-cols-2 gap-3">
              <label className={`text-xs font-medium text-slate-600 ${isFerryFormula ? "col-span-2" : ""}`}>
                Data arrivo
                <DateInput value={arrivalDate} onChange={(iso) => setArrivalDate(iso)} className="mt-1 input-saas w-full" />
              </label>
              {!isFerryFormula ? <label className="text-xs font-medium text-slate-600">
                Ora arrivo
                <input type="time" step="300" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} className="mt-1 input-saas w-full" />
              </label> : null}
              <label className={`text-xs font-medium text-slate-600 ${isFerryFormula ? "col-span-2" : ""}`}>
                Data partenza
                <DateInput value={departureDate} onChange={(iso) => setDepartureDate(iso)} className="mt-1 input-saas w-full" />
              </label>
              {!isFerryFormula ? <label className="text-xs font-medium text-slate-600">
                Ora partenza
                <input type="time" step="300" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} className="mt-1 input-saas w-full" />
              </label> : null}
            </div>
          </div>

          {isFerryFormula ? (
            <div className="sm:col-span-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">Orari marittimi e pickup — modificabili per emergenza</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col text-xs font-medium text-slate-700">
                  <span className="sm:min-h-8">Partenza traghetto/aliscafo dalla terraferma</span>
                  <input type="time" step="300" value={outboundFerryDeparture} onChange={(e) => setOutboundFerryDeparture(e.target.value)} className="mt-1 input-saas w-full" />
                </label>
                <label className="flex flex-col text-xs font-medium text-slate-700">
                  <span className="sm:min-h-8">Arrivo indicativo sull&apos;isola</span>
                  <input type="time" step="300" value={outboundFerryArrival} onChange={(e) => setOutboundFerryArrival(e.target.value)} className="mt-1 input-saas w-full" />
                </label>
                <label className="flex flex-col text-xs font-medium text-slate-700">
                  <span className="sm:min-h-8">Pickup hotel per la partenza</span>
                  <input type="time" step="300" value={returnPickup} onChange={(e) => setReturnPickup(e.target.value)} className="mt-1 input-saas w-full" />
                </label>
                <label className="flex flex-col text-xs font-medium text-slate-700">
                  <span className="sm:min-h-8">Partenza traghetto/aliscafo dall&apos;isola</span>
                  <input type="time" step="300" value={returnFerryDeparture} onChange={(e) => setReturnFerryDeparture(e.target.value)} className="mt-1 input-saas w-full" />
                </label>
              </div>
            </div>
          ) : null}

          {/* Rif. volo/treno */}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Rif. volo / treno
            <input value={transportCode} onChange={(e) => setTransportCode(e.target.value)} placeholder="Es. FR1234 / IC345" className="mt-1 input-saas w-full" />
          </label>

          {/* Meeting point */}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Meeting point
            <input value={meetingPoint} onChange={(e) => setMeetingPoint(e.target.value)} className="mt-1 input-saas w-full" />
          </label>

          {/* Agenzia */}
          <div className="sm:col-span-2">
            <span className="text-xs font-medium text-slate-600">Agenzia</span>
            <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)} className="mt-1 input-saas w-full">
              <option value="">— Nessuna agenzia —</option>
              {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          {/* Note */}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Note
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1 input-saas w-full resize-none" />
          </label>

          {/* Note interne */}
          <div className="sm:col-span-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-slate-600">Note interne</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 tracking-wide">Visibile solo all&apos;ufficio</span>
              {internalNotesSaving && <span className="text-[10px] text-slate-400">Salvataggio...</span>}
            </div>
            <textarea
              value={internalNotes}
              onChange={(e) => handleInternalNotesChange(e.target.value)}
              rows={3}
              placeholder="Annotazioni riservate all'ufficio..."
              className="input-saas w-full resize-none"
            />
            {internalNotesUpdatedAt && (
              <p className="mt-1 text-[10px] text-slate-400">
                Ultimo aggiornamento: {new Date(internalNotesUpdatedAt).toLocaleString("it-IT")}
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => {
              if (!service?.id || !accessToken) return;
              const popup = window.open("", "_blank", "noopener,noreferrer");
              if (!popup) return;
              fetch(`/api/services/${service.id}/voucher/pdf`, { headers: { Authorization: `Bearer ${accessToken}` } })
                .then((r) => r.text())
                .then((html) => { popup.document.open(); popup.document.write(html); popup.document.close(); })
                .catch(() => popup.close());
            }}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Voucher PDF
          </button>
          <button
            type="button"
            onClick={() => void sendWhatsAppReminder()}
            disabled={whatsAppBusy || !(service.phone_e164 || service.phone)}
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {whatsAppBusy ? "Invio WhatsApp..." : "Invia WhatsApp"}
          </button>
          <button type="button" onClick={() => router.back()} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            Annulla
          </button>
          <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
            {saving ? "Salvataggio..." : "Salva modifiche"}
          </button>
        </div>
        {whatsAppMessage ? <p className="text-xs text-slate-600">{whatsAppMessage}</p> : null}
        {service.sent_at ? <p className="text-xs text-slate-500">Ultimo invio WhatsApp: {new Date(service.sent_at).toLocaleString("it-IT")}</p> : null}

        {isBusBooking && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">QR Bus</p>
                <p className="mt-1 text-xs text-slate-500">
                  Gestione QR andata/ritorno per invio cliente, verifica assistente e stampa PDF.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void regenerateBusQr()} disabled={qrBusy !== null} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">
                  {qrBusy === "generate" ? "Rigenero..." : "Rigenera"}
                </button>
                <button type="button" onClick={() => void openBusQrPdf()} disabled={qrBusy !== null} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">
                  {qrBusy === "pdf" ? "Apro..." : "Scarica PDF"}
                </button>
                <button type="button" onClick={() => void sendBusQrWhatsApp("both")} disabled={qrBusy !== null} className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  {qrBusy === "whatsapp" ? "Invio..." : "Invia entrambi"}
                </button>
              </div>
            </div>

            {qrMessage && <p className="mt-3 text-xs text-slate-600">{qrMessage}</p>}

            {qrLoading ? (
              <p className="mt-4 text-sm text-slate-500">Caricamento QR bus...</p>
            ) : qrSummary ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(["outbound", "return"] as const).map((direction) => {
                  const qr = qrSummary.codes.find((item) => item.direction === direction);
                  return (
                    <div key={direction} className="rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                            {direction === "outbound" ? "ANDATA" : "RITORNO"}
                          </p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{qr?.service_date ?? "Non generato"}</p>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${qr?.status === "used" ? "bg-slate-100 text-slate-700" : qr?.status === "cancelled" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                          {qr?.status ?? "missing"}
                        </span>
                      </div>

                      {qr ? (
                        <>
                          <Image
                            src={qr.qr_image_url}
                            alt={`QR ${direction}`}
                            width={176}
                            height={176}
                            unoptimized
                            className="mx-auto mt-3 h-44 w-44 rounded-xl border border-slate-100 object-contain"
                          />
                          <div className="mt-3 flex flex-wrap gap-2">
                            <a
                              href={qr.qr_image_url}
                              download={`bus-${qrSummary.bookingId}-${direction}.png`}
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                            >
                              Scarica PNG
                            </a>
                            <button
                              type="button"
                              onClick={() => void sendBusQrWhatsApp(direction)}
                              disabled={qrBusy !== null}
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
                            >
                              Invia WhatsApp
                            </button>
                          </div>
                          {qr.used_at && (
                            <p className="mt-3 text-xs text-slate-500">
                              Usato il {new Date(qr.used_at).toLocaleString("it-IT")}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="mt-3 text-sm text-slate-500">Nessun QR disponibile per questa tratta.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-500">I QR verranno creati appena la prenotazione bus viene generata o rigenerata.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
