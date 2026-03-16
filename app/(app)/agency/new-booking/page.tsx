"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { agencyBookingCreateSchema } from "@/lib/validation";

type BookingKind = z.infer<typeof agencyBookingCreateSchema>["booking_service_kind"];
type AgencyRole = "admin" | "agency";

interface HotelOption {
  id: string;
  name: string;
  zone: string | null;
}

interface AgencyOption {
  id: string;
  name: string;
}

const kindOptions: Array<{ value: BookingKind; label: string }> = [
  { value: "transfer_port_hotel", label: "Transfer porto - hotel" },
  { value: "transfer_airport_hotel", label: "Transfer aeroporto - hotel" },
  { value: "transfer_train_hotel", label: "Transfer stazione - hotel" },
  { value: "bus_city_hotel", label: "Bus da citta italiane - hotel" },
  { value: "excursion", label: "Escursioni" }
];
const defaultConfirmationEmail = process.env.NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL?.trim() ?? "";

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function bookingContext(kind: BookingKind) {
  if (kind === "transfer_airport_hotel") {
    return {
      arrivalDateLabel: "Data volo andata*",
      arrivalTimeLabel: "Ora volo andata*",
      departureDateLabel: "Data volo ritorno*",
      departureTimeLabel: "Ora volo ritorno*",
      transportCodeLabel: "Numero volo*",
      transportCodePlaceholder: "Es. FR1234"
    };
  }
  if (kind === "transfer_train_hotel") {
    return {
      arrivalDateLabel: "Data treno andata*",
      arrivalTimeLabel: "Ora treno andata*",
      departureDateLabel: "Data treno ritorno*",
      departureTimeLabel: "Ora treno ritorno*",
      transportCodeLabel: "Numero treno*",
      transportCodePlaceholder: "Es. FRECCIAROSSA 9527"
    };
  }
  if (kind === "bus_city_hotel") {
    return {
      arrivalDateLabel: "Data bus andata*",
      arrivalTimeLabel: "Ora bus andata*",
      departureDateLabel: "Data bus ritorno*",
      departureTimeLabel: "Ora bus ritorno*",
      transportCodeLabel: "Riferimento bus",
      transportCodePlaceholder: "Es. Linea / numero corsa"
    };
  }
  if (kind === "excursion") {
    return {
      arrivalDateLabel: "Data escursione*",
      arrivalTimeLabel: "Ora inizio*",
      departureDateLabel: "Data rientro*",
      departureTimeLabel: "Ora rientro*",
      transportCodeLabel: "Riferimento operativo",
      transportCodePlaceholder: "Facoltativo"
    };
  }
  return {
    arrivalDateLabel: "Data andata*",
    arrivalTimeLabel: "Ora andata*",
    departureDateLabel: "Data ritorno*",
    departureTimeLabel: "Ora ritorno*",
    transportCodeLabel: "Riferimento mezzo",
    transportCodePlaceholder: "Facoltativo"
  };
}

export default function AgencyNewBookingPage() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Compila i campi obbligatori e conferma la prenotazione.");
  const [submitting, setSubmitting] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [role, setRole] = useState<AgencyRole | null>(null);
  const [hotels, setHotels] = useState<HotelOption[]>([]);
  const [agencies, setAgencies] = useState<AgencyOption[]>([]);
  const [form, setForm] = useState({
    customer_first_name: "",
    customer_last_name: "",
    customer_phone: "",
    customer_email: defaultConfirmationEmail,
    pax: "2",
    hotel_id: "",
    booking_service_kind: "transfer_port_hotel" as BookingKind,
    arrival_date: todayIsoDate(),
    arrival_time: "12:00",
    departure_date: todayIsoDate(),
    departure_time: "12:00",
    transport_code: "",
    bus_city_origin: "",
    include_ferry_tickets: false,
    ferry_outbound_code: "",
    ferry_return_code: "",
    excursion_title: "",
    notes: "",
    agency_id: ""
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;

    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      if (session.mode === "demo" || !hasSupabaseEnv || !supabase || !session.tenantId) {
        setMessage("Area agenzia disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }
      if (session.role !== "agency" && session.role !== "admin") {
        setMessage("Ruolo non autorizzato per questa sezione.");
        setLoading(false);
        return;
      }

      setRole(session.role);
      const { data: tokenData } = await supabase.auth.getSession();
      const token = tokenData.session?.access_token ?? null;
      setAccessToken(token);

      const [hotelRes, agencyRes] = await Promise.all([
        supabase.from("hotels").select("id, name, zone").eq("tenant_id", session.tenantId).order("name", { ascending: true }).limit(2000),
        session.role === "admin"
          ? supabase.from("agencies").select("id, name").eq("tenant_id", session.tenantId).eq("active", true).order("name", { ascending: true })
          : Promise.resolve({ data: [], error: null })
      ]);

      if (!active) return;
      if (hotelRes.error) {
        setMessage("Errore caricamento hotel.");
        setLoading(false);
        return;
      }

      const hotelRows = (hotelRes.data ?? []) as HotelOption[];
      setHotels(hotelRows);
      if (hotelRows[0]?.id) {
        setForm((prev) => ({ ...prev, hotel_id: prev.hotel_id || hotelRows[0].id }));
      }

      if (session.role === "admin") {
        if (agencyRes.error) {
          setMessage("Errore caricamento agenzie.");
        } else {
          const agencyRows = (agencyRes.data ?? []) as AgencyOption[];
          setAgencies(agencyRows);
          if (agencyRows[0]?.id) {
            setForm((prev) => ({ ...prev, agency_id: prev.agency_id || agencyRows[0].id }));
          }
        }
      }

      setLoading(false);
    };

    void boot();
    return () => {
      active = false;
    };
  }, []);

  const selectedKind = form.booking_service_kind;
  const isTransportCodeRequired = selectedKind === "transfer_airport_hotel" || selectedKind === "transfer_train_hotel";
  const isBusOriginRequired = selectedKind === "bus_city_hotel";
  const isExcursionTitleRequired = selectedKind === "excursion";
  const hasHotels = hotels.length > 0;
  const hasAgenciesIfAdmin = role !== "admin" || agencies.length > 0;
  const normalizedPayload = useMemo(
    () => ({
      ...form,
      pax: Number(form.pax || "0"),
      notes: form.notes.trim()
    }),
    [form]
  );
  const parsedPreview = useMemo(() => agencyBookingCreateSchema.safeParse(normalizedPayload), [normalizedPayload]);
  const isFormValid = parsedPreview.success && hasHotels && hasAgenciesIfAdmin;

  const serviceKindLabel = useMemo(
    () => kindOptions.find((item) => item.value === selectedKind)?.label ?? "Servizio",
    [selectedKind]
  );
  const contextLabels = useMemo(() => bookingContext(selectedKind), [selectedKind]);

  const submit = async () => {
    if (!accessToken) {
      setMessage("Sessione non valida. Rifai login.");
      return;
    }
    const parsed = agencyBookingCreateSchema.safeParse(normalizedPayload);
    if (!parsed.success) {
      const nextFieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !nextFieldErrors[key]) {
          nextFieldErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextFieldErrors);
      setMessage(parsed.error.issues[0]?.message ?? "Dati non validi.");
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    const response = await fetch("/api/agency/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(parsed.data)
    });
    const body = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          id?: string;
          existing_id?: string;
          duplicate?: boolean;
          error?: string;
          email_confirmation?: { status: string; error: string | null };
        }
      | null;

    if (!response.ok || (!body?.id && !body?.existing_id)) {
      setSubmitting(false);
      setMessage(body?.error ?? "Creazione prenotazione non riuscita.");
      return;
    }

    if (body.duplicate && body.existing_id) {
      setSubmitting(false);
      setMessage(`Prenotazione gia presente (${serviceKindLabel}). ID esistente: ${body.existing_id}`);
      return;
    }

    const emailStatus = body.email_confirmation?.status ? ` | Conferma email: ${body.email_confirmation.status}` : "";
    setMessage(`Prenotazione creata (${serviceKindLabel}). ID: ${body.id ?? body.existing_id}${emailStatus}`);
    setSubmitting(false);
    setForm((prev) => ({
      ...prev,
      customer_first_name: "",
      customer_last_name: "",
      customer_phone: "",
      customer_email: defaultConfirmationEmail,
      transport_code: "",
      bus_city_origin: "",
      ferry_outbound_code: "",
      ferry_return_code: "",
      excursion_title: "",
      notes: ""
    }));
  };

  if (loading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento area agenzia...</div>;
  }

  if (!hasSupabaseEnv || !supabase) {
    return <div className="card p-4 text-sm text-slate-500">Supabase non configurato.</div>;
  }

  return (
    <section className="mx-auto max-w-5xl page-section">
      <div className="section-head">
        <h1 className="section-title">Nuova prenotazione agenzia</h1>
        <p className="section-subtitle">Modulo reale con persistenza Supabase e conferma email opzionale.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/agency/bookings" className="btn-secondary px-3 py-1.5 text-xs">
          Vai a mie prenotazioni
        </Link>
        {role === "admin" ? (
          <Link href="/agency" className="btn-secondary px-3 py-1.5 text-xs">
            Vai area agenzia
          </Link>
        ) : null}
      </div>

      {!hasHotels ? (
        <article className="card space-y-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Nessun hotel disponibile per il tenant corrente.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/hotels" className="btn-secondary px-3 py-1.5 text-xs">
              Apri hotel
            </Link>
            <Link href="/onboarding" className="btn-primary px-3 py-1.5 text-xs">
              Vai a onboarding
            </Link>
          </div>
        </article>
      ) : null}
      {role === "admin" && !hasAgenciesIfAdmin ? (
        <article className="card space-y-1 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Nessuna agenzia attiva disponibile.</p>
          <p>Prima di creare una prenotazione da admin, configura almeno una agenzia nel tenant.</p>
        </article>
      ) : null}

      <div className="card grid gap-3 p-4 md:grid-cols-2 md:p-5">
        <label className="text-sm">
          Nome cliente*
          <input
            className="input-saas mt-1"
            value={form.customer_first_name}
            onChange={(event) => setForm((prev) => ({ ...prev, customer_first_name: event.target.value }))}
          />
          {fieldErrors.customer_first_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_first_name}</span> : null}
        </label>
        <label className="text-sm">
          Cognome cliente*
          <input
            className="input-saas mt-1"
            value={form.customer_last_name}
            onChange={(event) => setForm((prev) => ({ ...prev, customer_last_name: event.target.value }))}
          />
          {fieldErrors.customer_last_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_last_name}</span> : null}
        </label>
        <label className="text-sm">
          Telefono*
          <input
            className="input-saas mt-1"
            value={form.customer_phone}
            onChange={(event) => setForm((prev) => ({ ...prev, customer_phone: event.target.value }))}
          />
          {fieldErrors.customer_phone ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_phone}</span> : null}
        </label>
        <label className="text-sm">
          Email cliente (per conferma)
          <input
            type="email"
            className="input-saas mt-1"
            value={form.customer_email}
            onChange={(event) => setForm((prev) => ({ ...prev, customer_email: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          Pax*
          <input
            type="number"
            min={1}
            max={16}
            className="input-saas mt-1"
            value={form.pax}
            onChange={(event) => setForm((prev) => ({ ...prev, pax: event.target.value }))}
          />
          {fieldErrors.pax ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.pax}</span> : null}
        </label>
        <label className="text-sm">
          Hotel / Struttura*
          <select
            className="input-saas mt-1"
            value={form.hotel_id}
            onChange={(event) => setForm((prev) => ({ ...prev, hotel_id: event.target.value }))}
          >
            {hotels.map((hotel) => (
              <option key={hotel.id} value={hotel.id}>
                {hotel.name}
                {hotel.zone ? ` - ${hotel.zone}` : ""}
              </option>
            ))}
          </select>
          {fieldErrors.hotel_id ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.hotel_id}</span> : null}
        </label>
        <label className="text-sm md:col-span-2">
          Tipo servizio*
          <select
            className="input-saas mt-1"
            value={form.booking_service_kind}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, booking_service_kind: event.target.value as BookingKind }))
            }
          >
            {kindOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {contextLabels.arrivalDateLabel}
          <input
            type="date"
            className="input-saas mt-1"
            value={form.arrival_date}
            onChange={(event) => setForm((prev) => ({ ...prev, arrival_date: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          {contextLabels.arrivalTimeLabel}
          <input
            type="time"
            className="input-saas mt-1"
            value={form.arrival_time}
            onChange={(event) => setForm((prev) => ({ ...prev, arrival_time: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          {contextLabels.departureDateLabel}
          <input
            type="date"
            className="input-saas mt-1"
            value={form.departure_date}
            onChange={(event) => setForm((prev) => ({ ...prev, departure_date: event.target.value }))}
          />
        </label>
        <label className="text-sm">
          {contextLabels.departureTimeLabel}
          <input
            type="time"
            className="input-saas mt-1"
            value={form.departure_time}
            onChange={(event) => setForm((prev) => ({ ...prev, departure_time: event.target.value }))}
          />
        </label>

        {isTransportCodeRequired || selectedKind === "bus_city_hotel" || selectedKind === "excursion" ? (
          <label className="text-sm md:col-span-2">
            {contextLabels.transportCodeLabel}
            <input
              className="input-saas mt-1"
              placeholder={contextLabels.transportCodePlaceholder}
              value={form.transport_code}
              onChange={(event) => setForm((prev) => ({ ...prev, transport_code: event.target.value }))}
            />
            {!isTransportCodeRequired ? (
              <span className="mt-1 block text-xs text-slate-500">Campo facoltativo ma utile per riconoscere il mezzo o la corsa.</span>
            ) : null}
            {fieldErrors.transport_code ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.transport_code}</span> : null}
          </label>
        ) : null}
        {isBusOriginRequired ? (
          <label className="text-sm md:col-span-2">
            Citta partenza bus*
            <input
              className="input-saas mt-1"
              value={form.bus_city_origin}
              onChange={(event) => setForm((prev) => ({ ...prev, bus_city_origin: event.target.value }))}
            />
            {fieldErrors.bus_city_origin ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.bus_city_origin}</span> : null}
          </label>
        ) : null}
        {isExcursionTitleRequired ? (
          <label className="text-sm md:col-span-2">
            Escursione*
            <input
              className="input-saas mt-1"
              value={form.excursion_title}
              onChange={(event) => setForm((prev) => ({ ...prev, excursion_title: event.target.value }))}
            />
            {fieldErrors.excursion_title ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.excursion_title}</span> : null}
          </label>
        ) : null}

        <label className="text-sm md:col-span-2">
          <span className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.include_ferry_tickets}
              onChange={(event) => setForm((prev) => ({ ...prev, include_ferry_tickets: event.target.checked }))}
            />
            Biglietti nave collegati al transfer
          </span>
        </label>
        {form.include_ferry_tickets ? (
          <>
            <label className="text-sm">
              Codice nave andata
              <input
                className="input-saas mt-1"
                value={form.ferry_outbound_code}
                onChange={(event) => setForm((prev) => ({ ...prev, ferry_outbound_code: event.target.value }))}
              />
            </label>
            <label className="text-sm">
              Codice nave ritorno
              <input
                className="input-saas mt-1"
                value={form.ferry_return_code}
                onChange={(event) => setForm((prev) => ({ ...prev, ferry_return_code: event.target.value }))}
              />
            </label>
          </>
        ) : null}

        {role === "admin" ? (
          <label className="text-sm md:col-span-2">
            Agenzia associata*
            <select
              className="input-saas mt-1"
              value={form.agency_id}
              onChange={(event) => setForm((prev) => ({ ...prev, agency_id: event.target.value }))}
            >
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </select>
            {fieldErrors.agency_id ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.agency_id}</span> : null}
          </label>
        ) : (
          <p className="text-xs text-slate-600 md:col-span-2">Agenzia associata automaticamente al tuo account.</p>
        )}

        <label className="text-sm md:col-span-2">
          Note*
          <textarea
            rows={4}
            className="input-saas mt-1 min-h-[104px]"
            value={form.notes}
            onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
          />
          {fieldErrors.notes ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.notes}</span> : null}
        </label>

        <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted md:col-span-2">
          <p className="font-semibold text-text">Anteprima prenotazione</p>
          <p className="mt-1">
            {form.customer_first_name || "Nome"} {form.customer_last_name || "Cognome"} | {serviceKindLabel} | Pax {form.pax || "0"}
          </p>
          <p>
            {contextLabels.arrivalDateLabel.replace("*", "")} {form.arrival_date} {form.arrival_time} - {contextLabels.departureDateLabel.replace("*", "")} {form.departure_date} {form.departure_time}
          </p>
          {form.transport_code ? <p>{contextLabels.transportCodeLabel}: {form.transport_code}</p> : null}
        </div>

        <button type="button" onClick={() => void submit()} disabled={submitting || !isFormValid} className="btn-primary md:col-span-2 disabled:opacity-60">
          {submitting ? "Creazione in corso..." : "Conferma prenotazione"}
        </button>
      </div>

      <p className="section-subtitle">{message}</p>
    </section>
  );
}
