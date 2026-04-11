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

interface BusCatalogStop {
  city: string;
  time: string;
  pickupNote: string | null;
  lineCode: string;
  lineName: string;
}

type BusLineFamily = "ITALIA" | "CENTRO" | "ADRIATICA";

function deriveBusLineFamily(lineCode: string): BusLineFamily {
  const normalized = lineCode.toLowerCase();
  const match = normalized.match(/linea[_\s-]*(\d{1,2})/);
  const lineNumber = match ? Number(match[1]) : null;
  if (lineNumber === 7) return "CENTRO";
  if (lineNumber === 11 || normalized.includes("adriatica")) return "ADRIATICA";
  return "ITALIA";
}

const kindOptions: Array<{ value: BookingKind; label: string }> = [
  { value: "formula_snav", label: "Formula SNAV" },
  { value: "formula_medmar", label: "Formula MEDMAR" },
  { value: "transfer_airport_hotel", label: "Transfer aeroporto - hotel" },
  { value: "transfer_airport_hotel_exclusive", label: "Transfer aeroporto - hotel (esclusivo 🔒)" },
  { value: "transfer_train_hotel", label: "Transfer stazione / bus - hotel" },
  { value: "transfer_train_hotel_exclusive", label: "Transfer stazione / bus - hotel (esclusivo 🔒)" },
  { value: "bus_city_hotel", label: "Linea bus - hotel" },
  { value: "excursion", label: "Escursione" },
  { value: "transfer_port_hotel", label: "Transfer porto - hotel" }
];
const defaultConfirmationEmail = process.env.NEXT_PUBLIC_AGENCY_DEFAULT_CONFIRMATION_EMAIL?.trim() ?? "";

// Orari traghetti da schedule fisso
const SNAV_ARRIVAL_TIMES = ["08:25", "12:30", "16:20", "19:00"]; // Napoli → Casamicciola
const SNAV_DEPARTURE_TIMES = ["07:10", "09:45", "14:00", "17:40"]; // Casamicciola → Napoli
const MEDMAR_ARRIVAL_TIMES = ["08:15", "08:40", "09:40", "12:00", "13:30", "14:20", "15:00", "16:30", "18:30", "19:00"];
const MEDMAR_DEPARTURE_TIMES = ["06:20", "08:10", "10:10", "10:35", "11:10", "13:35", "15:00", "16:50", "17:00"];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isSunday(dateStr: string): boolean {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getDay() === 0;
}

/** Restituisce la domenica più vicina >= fromDate. Se skipSame=true, salta se già domenica. */
function nextSunday(fromDate: string, skipSame = false): string {
  const [y, m, d] = fromDate.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  const day = date.getDay();
  const daysToAdd = day === 0 ? (skipSame ? 7 : 0) : 7 - day;
  date.setDate(date.getDate() + daysToAdd);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function bookingContext(kind: BookingKind) {
  if (kind === "formula_snav" || kind === "formula_medmar") {
    const label = kind === "formula_snav" ? "SNAV" : "MEDMAR";
    return {
      arrivalDateLabel: `Data arrivo ${label}*`,
      arrivalTimeLabel: `Ora arrivo ${label}*`,
      departureDateLabel: `Data partenza ${label}*`,
      departureTimeLabel: `Ora partenza ${label}*`,
      transportCodeLabel: "Riferimento prenotazione",
      transportCodePlaceholder: "Facoltativo",
      transportCodeReturnLabel: undefined as string | undefined,
      transportCodeReturnPlaceholder: undefined as string | undefined
    };
  }
  if (kind === "transfer_airport_hotel" || kind === "transfer_airport_hotel_exclusive") {
    return {
      arrivalDateLabel: "Data volo andata*",
      arrivalTimeLabel: "Ora arrivo volo andata*",
      departureDateLabel: "Data volo ritorno*",
      departureTimeLabel: "Ora partenza volo ritorno*",
      transportCodeLabel: "Numero volo andata*",
      transportCodePlaceholder: "Es. FR1234",
      transportCodeReturnLabel: "Numero volo ritorno*",
      transportCodeReturnPlaceholder: "Es. FR5678"
    };
  }
  if (kind === "transfer_train_hotel" || kind === "transfer_train_hotel_exclusive") {
    return {
      arrivalDateLabel: "Data arrivo*",
      arrivalTimeLabel: "Ora arrivo*",
      departureDateLabel: "Data ritorno*",
      departureTimeLabel: "Ora partenza ritorno*",
      transportCodeLabel: "Treno / Bus andata",
      transportCodePlaceholder: "Es. FRECCIAROSSA 9527 o FlixBus",
      transportCodeReturnLabel: "Treno / Bus ritorno",
      transportCodeReturnPlaceholder: "Es. FRECCIAROSSA 9530 o FlixBus"
    };
  }
  if (kind === "bus_city_hotel") {
    return {
      arrivalDateLabel: "Data arrivo bus*",
      arrivalTimeLabel: "Ora arrivo bus andata*",
      departureDateLabel: "Data ritorno bus*",
      departureTimeLabel: "Ora partenza bus ritorno*",
      transportCodeLabel: "Riferimento bus andata",
      transportCodePlaceholder: "Es. Linea / numero corsa",
      transportCodeReturnLabel: "Riferimento bus ritorno" as string | undefined,
      transportCodeReturnPlaceholder: "Es. Linea / numero corsa" as string | undefined
    };
  }
  if (kind === "excursion") {
    return {
      arrivalDateLabel: "Data escursione*",
      arrivalTimeLabel: "Ora inizio*",
      departureDateLabel: "Data rientro*",
      departureTimeLabel: "Ora rientro*",
      transportCodeLabel: "Riferimento operativo",
      transportCodePlaceholder: "Facoltativo",
      transportCodeReturnLabel: undefined as string | undefined,
      transportCodeReturnPlaceholder: undefined as string | undefined
    };
  }
  return {
    arrivalDateLabel: "Data andata*",
    arrivalTimeLabel: "Ora andata*",
    departureDateLabel: "Data ritorno*",
    departureTimeLabel: "Ora ritorno*",
    transportCodeLabel: "Riferimento mezzo",
    transportCodePlaceholder: "Facoltativo",
    transportCodeReturnLabel: undefined as string | undefined,
    transportCodeReturnPlaceholder: undefined as string | undefined
  };
}

export default function AgencyNewBookingPage() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Compila i campi obbligatori e conferma la prenotazione.");
  const [submitting, setSubmitting] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [role, setRole] = useState<AgencyRole | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
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
    transport_code_return: "",
    bus_city_origin: "",
    excursion_title: "",
    notes: "",
    agency_id: "",
    quoted_price_eur: ""
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [addingHotel, setAddingHotel] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [newHotelAddress, setNewHotelAddress] = useState("");
  const [newHotelCity, setNewHotelCity] = useState("");
  const [savingHotel, setSavingHotel] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<{
    customer_name: string;
    date: string;
    direction: string;
    hotel_name: string;
    arrival_date: string | null;
    departure_date: string | null;
  } | null>(null);
  const [busStops, setBusStops] = useState<BusCatalogStop[]>([]);
  const [busSearch, setBusSearch] = useState("");
  const [busSearchOpen, setBusSearchOpen] = useState(false);
  const [busLoading, setBusLoading] = useState(false);
  const [selectedBusStop, setSelectedBusStop] = useState<BusCatalogStop | null>(null);
  const [busReturnTime, setBusReturnTime] = useState<string | null>(null);
  const [busReturnTimeLoading, setBusReturnTimeLoading] = useState(false);
  const [excursionLines, setExcursionLines] = useState<Array<{ id: string; name: string }>>([]);

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
      setTenantId(session.tenantId);
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

  // Carica escursioni dal DB quando il tipo è excursion
  useEffect(() => {
    if (form.booking_service_kind !== "excursion" || !supabase || !tenantId || excursionLines.length > 0) return;
    supabase
      .from("excursion_lines")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        if (data && data.length > 0) {
          setExcursionLines(data as Array<{ id: string; name: string }>);
          setForm((prev) => ({ ...prev, excursion_title: prev.excursion_title || data[0]?.name || "" }));
        }
      });
  }, [form.booking_service_kind, supabase, tenantId, excursionLines.length]);

  // Carica catalogo fermate bus quando il tipo è bus_city_hotel
  useEffect(() => {
    if (form.booking_service_kind !== "bus_city_hotel" || !accessToken || busStops.length > 0) return;
    setBusLoading(true);
    fetch("/api/agency/bus-catalog", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((r) => r.json())
      .then((body: { stops?: BusCatalogStop[] }) => { setBusStops(body.stops ?? []); })
      .catch(() => {})
      .finally(() => setBusLoading(false));
  }, [form.booking_service_kind, accessToken, busStops.length]);

  // Carica orario pick-up ritorno quando cambia hotel o fermata bus selezionata
  useEffect(() => {
    if (form.booking_service_kind !== "bus_city_hotel" || !selectedBusStop || !form.hotel_id || !accessToken) {
      setBusReturnTime(null);
      return;
    }
    const lineFamily = deriveBusLineFamily(selectedBusStop.lineCode);
    setBusReturnTimeLoading(true);
    fetch(
      `/api/agency/bus-return-time?hotel_id=${encodeURIComponent(form.hotel_id)}&line_family=${lineFamily}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
      .then((r) => r.json())
      .then((body: { pickup_time?: string | null }) => {
        const t = body.pickup_time ?? null;
        setBusReturnTime(t);
        if (t) {
          setForm((prev) => ({ ...prev, departure_time: t }));
        }
      })
      .catch(() => { setBusReturnTime(null); })
      .finally(() => setBusReturnTimeLoading(false));
  }, [selectedBusStop, form.hotel_id, form.booking_service_kind, accessToken]);

  const createHotel = async () => {
    if (!supabase || !tenantId || !newHotelName.trim()) return;
    setSavingHotel(true);
    const { data, error } = await supabase
      .from("hotels")
      .insert({
        tenant_id: tenantId,
        name: newHotelName.trim().toUpperCase(),
        address: newHotelAddress.trim() || "",
        city: newHotelCity.trim() || null,
        lat: 0,
        lng: 0,
        zone: ""
      })
      .select("id, name, zone")
      .single();
    setSavingHotel(false);
    if (error || !data?.id) {
      setMessage(`Errore creazione hotel: ${error?.message ?? "sconosciuto"}`);
      return;
    }
    const newHotel = { id: data.id, name: data.name, zone: data.zone ?? null } as HotelOption;
    setHotels((prev) => [...prev, newHotel].sort((a, b) => a.name.localeCompare(b.name, "it")));
    setForm((prev) => ({ ...prev, hotel_id: data.id }));
    setAddingHotel(false);
    setNewHotelName("");
    setNewHotelAddress("");
    setNewHotelCity("");
  };

  const selectedKind = form.booking_service_kind;
  const isSnavKind = selectedKind === "formula_snav";
  const isTransportCodeRequired = selectedKind === "transfer_airport_hotel" || selectedKind === "transfer_train_hotel";
  const showTransportCodeField = isTransportCodeRequired || selectedKind === "bus_city_hotel" || selectedKind === "excursion" || selectedKind === "formula_snav" || selectedKind === "formula_medmar";
  const isBusOriginRequired = selectedKind === "bus_city_hotel";
  const isExcursionTitleRequired = selectedKind === "excursion";
  const hasHotels = hotels.length > 0;
  const hasAgenciesIfAdmin = role !== "admin" || agencies.length > 0;
  const normalizedPayload = useMemo(
    () => ({
      ...form,
      pax: Number(form.pax || "0"),
      notes: form.notes.trim(),
      transport_code_return: form.transport_code_return.trim(),
      agency_quoted_price_cents: form.quoted_price_eur
        ? Math.round(Number(form.quoted_price_eur.replace(",", ".")) * 100)
        : null
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
  const reviewWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (isSnavKind) {
      if (!form.customer_last_name.trim()) warnings.push("Inserisci il nome completo del cliente.");
    } else {
      if (!form.customer_first_name.trim() || !form.customer_last_name.trim()) warnings.push("Completa nome e cognome cliente.");
    }
    if (!form.customer_phone.trim()) warnings.push("Inserisci un telefono cliente.");
    if (!form.hotel_id) warnings.push("Seleziona la struttura.");
    if (!form.notes.trim()) warnings.push("Aggiungi una nota operativa.");
    if (isTransportCodeRequired && !form.transport_code.trim()) warnings.push(`${contextLabels.transportCodeLabel.replace("*", "")} mancante.`);
    if (isTransportCodeRequired && contextLabels.transportCodeReturnLabel && !form.transport_code_return.trim()) warnings.push(`${contextLabels.transportCodeReturnLabel.replace("*", "")} mancante.`);
    if (isBusOriginRequired && !form.bus_city_origin.trim()) warnings.push("Citta di partenza bus mancante.");
    if (isExcursionTitleRequired && !form.excursion_title.trim()) warnings.push("Nome escursione mancante.");
    return warnings;
  }, [
    contextLabels.transportCodeLabel,
    form.bus_city_origin,
    form.customer_first_name,
    form.customer_last_name,
    form.customer_phone,
    form.excursion_title,
    form.hotel_id,
    form.notes,
    form.transport_code,
    isBusOriginRequired,
    isExcursionTitleRequired,
    isSnavKind,
    isTransportCodeRequired
  ]);

  const doSubmit = async () => {
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

    setSubmitting(false);

    if (body?.duplicate) {
      const dupName = isSnavKind
        ? form.customer_last_name.trim()
        : `${form.customer_first_name.trim()} ${form.customer_last_name.trim()}`.trim();
      setMessage(`⚠️ Prenotazione duplicata: esiste già una pratica identica per ${dupName} (stesso hotel, data e orario). L'operatore è stato avvisato.`);
      return;
    }

    if (!response.ok || !body?.id) {
      setMessage(body?.error ?? "Creazione prenotazione non riuscita.");
      return;
    }

    setMessage(`Prenotazione creata (${serviceKindLabel}). ID: ${body.id}`);

    // Reset completo del form
    const firstHotelId = hotels[0]?.id ?? "";
    const firstAgencyId = agencies[0]?.id ?? "";
    setForm({
      customer_first_name: "",
      customer_last_name: "",
      customer_phone: "",
      customer_email: defaultConfirmationEmail,
      pax: "2",
      hotel_id: firstHotelId,
      booking_service_kind: "transfer_port_hotel",
      arrival_date: todayIsoDate(),
      arrival_time: "12:00",
      departure_date: todayIsoDate(),
      departure_time: "12:00",
      transport_code: "",
      transport_code_return: "",
      bus_city_origin: "",
      excursion_title: "",
      notes: "",
      agency_id: firstAgencyId,
      quoted_price_eur: ""
    });
    setFieldErrors({});
    setBusSearch("");
    setSelectedBusStop(null);
    setBusReturnTime(null);
  };

  const submit = async (force = false) => {
    const parsed = agencyBookingCreateSchema.safeParse(normalizedPayload);
    if (!parsed.success) {
      await doSubmit();
      return;
    }

    // Check duplicati solo se non forzato
    if (!force && accessToken) {
      const customerName = isSnavKind
        ? form.customer_last_name.trim()
        : `${form.customer_first_name.trim()} ${form.customer_last_name.trim()}`.trim();
      const phone = form.customer_phone.trim();

      if (customerName.length >= 2 && phone.length >= 4) {
        try {
          const res = await fetch(
            `/api/agency/check-duplicate?name=${encodeURIComponent(customerName)}&phone=${encodeURIComponent(phone)}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const body = await res.json() as {
            found: boolean;
            service?: {
              date: string; direction: string; hotel_name: string;
              arrival_date: string | null; departure_date: string | null;
            };
          };
          if (body.found && body.service) {
            setDuplicateWarning({
              customer_name: customerName,
              date: body.service.date,
              direction: body.service.direction === "arrival" ? "Arrivo" : "Partenza",
              hotel_name: body.service.hotel_name,
              arrival_date: body.service.arrival_date,
              departure_date: body.service.departure_date,
            });
            return;
          }
        } catch {
          // Se il check fallisce, procedi comunque con l'invio
        }
      }
    }

    setDuplicateWarning(null);
    await doSubmit();
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
        <label className="text-sm md:col-span-2">
          Tipo servizio*
          <select
            className="input-saas mt-1"
            value={form.booking_service_kind}
            onChange={(event) => {
              const kind = event.target.value as BookingKind;
              setForm((prev) => {
                const arrivalDate = kind === "bus_city_hotel" ? nextSunday(prev.arrival_date) : prev.arrival_date;
                const departureDate = kind === "bus_city_hotel" ? nextSunday(prev.departure_date, true) : prev.departure_date;
                return {
                  ...prev,
                  booking_service_kind: kind,
                  arrival_date: arrivalDate,
                  departure_date: departureDate,
                  arrival_time: kind === "formula_snav" ? SNAV_ARRIVAL_TIMES[0] : kind === "formula_medmar" ? MEDMAR_ARRIVAL_TIMES[0] : prev.arrival_time,
                  departure_time: kind === "formula_snav" ? SNAV_DEPARTURE_TIMES[0] : kind === "formula_medmar" ? MEDMAR_DEPARTURE_TIMES[0] : prev.departure_time
                };
              });
              if (kind !== "bus_city_hotel") {
                setBusSearch("");
                setSelectedBusStop(null);
              }
            }}
          >
            {kindOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {isSnavKind ? (
          <label className="text-sm md:col-span-2">
            Nome completo cliente*
            <input
              className="input-saas mt-1"
              placeholder="Es. Mario Rossi"
              value={form.customer_last_name}
              onChange={(event) => setForm((prev) => ({ ...prev, customer_last_name: event.target.value, customer_first_name: "" }))}
            />
            {fieldErrors.customer_last_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_last_name}</span> : null}
          </label>
        ) : (
          <>
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
          </>
        )}
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
        <div className="text-sm md:col-span-2">
          <div className="flex items-center justify-between">
            <span>Hotel / Struttura*</span>
            <button
              type="button"
              onClick={() => setAddingHotel((v) => !v)}
              className="text-xs text-blue-600 hover:underline"
            >
              {addingHotel ? "Annulla" : "+ Nuovo hotel"}
            </button>
          </div>
          {addingHotel ? (
            <div className="mt-2 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
              <input
                className="input-saas"
                placeholder="Nome hotel*"
                value={newHotelName}
                onChange={(e) => setNewHotelName(e.target.value)}
              />
              <input
                className="input-saas"
                placeholder="Indirizzo"
                value={newHotelAddress}
                onChange={(e) => setNewHotelAddress(e.target.value)}
              />
              <input
                className="input-saas"
                placeholder="Città"
                value={newHotelCity}
                onChange={(e) => setNewHotelCity(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void createHotel()}
                disabled={savingHotel || !newHotelName.trim()}
                className="btn-primary w-full py-1.5 text-xs disabled:opacity-60"
              >
                {savingHotel ? "Salvataggio..." : "Salva hotel"}
              </button>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
        {/* Arrivo: data + ora sulla stessa riga */}
        <div className="md:col-span-2 grid grid-cols-2 gap-3">
          <label className="text-sm">
            {contextLabels.arrivalDateLabel}
            <input
              type="date"
              className="input-saas mt-1"
              value={form.arrival_date}
              onChange={(event) => {
                const newDate = event.target.value;
                setForm((prev) => ({
                  ...prev,
                  arrival_date: newDate,
                  // Per le escursioni la data di fine coincide con quella di inizio
                  departure_date: prev.booking_service_kind === "excursion" ? newDate : prev.departure_date
                }));
              }}
            />
            {selectedKind === "bus_city_hotel" && form.arrival_date && !isSunday(form.arrival_date) ? (
              <span className="mt-1 block text-xs text-amber-600">Le linee bus operano solo la domenica.</span>
            ) : null}
          </label>
          <label className="text-sm">
            {contextLabels.arrivalTimeLabel}
            {(isSnavKind || selectedKind === "formula_medmar") ? (
              <select
                className="input-saas mt-1"
                value={form.arrival_time}
                onChange={(event) => setForm((prev) => ({ ...prev, arrival_time: event.target.value }))}
              >
                {(isSnavKind ? SNAV_ARRIVAL_TIMES : MEDMAR_ARRIVAL_TIMES).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            ) : (
              <input
                type="time"
                className="input-saas mt-1"
                value={form.arrival_time}
                onChange={(event) => setForm((prev) => ({ ...prev, arrival_time: event.target.value }))}
              />
            )}
          </label>
        </div>

        {/* Ritorno: data + ora sulla stessa riga */}
        <div className="md:col-span-2 grid grid-cols-2 gap-3">
          <label className="text-sm">
            {contextLabels.departureDateLabel}
            <input
              type="date"
              className={`input-saas mt-1${selectedKind === "bus_city_hotel" && form.departure_date && !isSunday(form.departure_date) ? " border-amber-400" : ""}`}
              value={form.departure_date}
              onChange={(event) => setForm((prev) => ({ ...prev, departure_date: event.target.value }))}
            />
            {selectedKind === "bus_city_hotel" && form.departure_date && !isSunday(form.departure_date) ? (
              <span className="mt-1 block text-xs text-amber-600">Le linee bus operano solo la domenica.</span>
            ) : null}
          </label>
          <label className="text-sm">
            {contextLabels.departureTimeLabel}
            {(isSnavKind || selectedKind === "formula_medmar") ? (
              <select
                className="input-saas mt-1"
                value={form.departure_time}
                onChange={(event) => setForm((prev) => ({ ...prev, departure_time: event.target.value }))}
              >
                {(isSnavKind ? SNAV_DEPARTURE_TIMES : MEDMAR_DEPARTURE_TIMES).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            ) : (
              <input
                type="time"
                className="input-saas mt-1"
                value={form.departure_time}
                onChange={(event) => setForm((prev) => ({ ...prev, departure_time: event.target.value }))}
              />
            )}
          </label>
        </div>

        {showTransportCodeField ? (
          <>
            <label className={`text-sm ${contextLabels.transportCodeReturnLabel ? "" : "md:col-span-2"}`}>
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
            {contextLabels.transportCodeReturnLabel ? (
              <label className="text-sm">
                {contextLabels.transportCodeReturnLabel}
                <input
                  className="input-saas mt-1"
                  placeholder={contextLabels.transportCodeReturnPlaceholder ?? ""}
                  value={form.transport_code_return}
                  onChange={(event) => setForm((prev) => ({ ...prev, transport_code_return: event.target.value }))}
                />
              </label>
            ) : null}
          </>
        ) : null}
        {isBusOriginRequired ? (
          <div className="text-sm md:col-span-2">
            <span className="font-medium text-slate-700">Città di partenza bus*</span>
            {busLoading ? (
              <p className="mt-2 text-xs text-slate-500">Caricamento orari linee bus...</p>
            ) : (
              <div className="relative mt-1">
                <input
                  className="input-saas"
                  placeholder="Cerca città (es. Roma, Milano, Bologna...)"
                  value={busSearch}
                  autoComplete="off"
                  onChange={(e) => {
                    setBusSearch(e.target.value);
                    setBusSearchOpen(true);
                    if (!e.target.value.trim()) {
                      setSelectedBusStop(null);
                      setForm((prev) => ({ ...prev, bus_city_origin: "" }));
                    }
                  }}
                  onFocus={() => setBusSearchOpen(true)}
                  onBlur={() => setTimeout(() => setBusSearchOpen(false), 150)}
                />
                {busSearchOpen && busSearch.trim().length >= 2 ? (() => {
                  const q = busSearch.trim().toLowerCase();
                  const filtered = busStops.filter((s) => s.city.toLowerCase().includes(q)).slice(0, 10);
                  return filtered.length > 0 ? (
                    <ul className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                      {filtered.map((s) => (
                        <li
                          key={`${s.lineCode}-${s.city}`}
                          className="cursor-pointer border-b border-slate-100 px-3 py-2.5 last:border-b-0 hover:bg-slate-50"
                          onMouseDown={() => {
                            setSelectedBusStop(s);
                            setBusSearch(s.city);
                            setBusSearchOpen(false);
                            setForm((prev) => ({
                              ...prev,
                              bus_city_origin: s.city,
                              arrival_time: s.time,
                              transport_code: s.lineName
                            }));
                          }}
                        >
                          <span className="font-semibold text-slate-800">{s.city}</span>
                          <span className="ml-2 text-xs text-slate-500">{s.lineName} · {s.time}</span>
                          {s.pickupNote ? <span className="mt-0.5 block text-xs text-slate-400">{s.pickupNote}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-amber-200 bg-white px-4 py-3 shadow-lg">
                      <p className="font-semibold text-amber-800">Città non trovata nel catalogo</p>
                      <p className="mt-1 text-sm text-amber-700">
                        Scrivi a{" "}
                        <a href="mailto:info@ischiatransferservice.it" className="font-medium text-blue-600 underline">
                          info@ischiatransferservice.it
                        </a>{" "}
                        per richiedere l'aggiunta della tua fermata.
                      </p>
                    </div>
                  );
                })() : null}
              </div>
            )}
            {selectedBusStop ? (
              <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <span className="font-semibold">{selectedBusStop.lineName}</span>
                {" · "}Orario pick-up andata:{" "}
                <span className="font-semibold">{selectedBusStop.time}</span>
                {selectedBusStop.pickupNote ? <span className="mt-0.5 block">📍 {selectedBusStop.pickupNote}</span> : null}
              </div>
            ) : null}
            {selectedBusStop && (busReturnTime || busReturnTimeLoading) ? (
              <div className="mt-1 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                {busReturnTimeLoading ? (
                  <span>Ricerca orario pick-up ritorno...</span>
                ) : busReturnTime ? (
                  <>
                    Orario pick-up ritorno:{" "}
                    <span className="font-semibold">{busReturnTime}</span>
                    <span className="ml-1 text-blue-600">(compilato automaticamente)</span>
                  </>
                ) : null}
              </div>
            ) : null}
            {selectedBusStop && !busReturnTimeLoading && !busReturnTime && form.hotel_id ? (
              <div className="mt-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Orario pick-up ritorno non trovato per questo hotel — inseriscilo manualmente.
              </div>
            ) : null}
            {fieldErrors.bus_city_origin ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.bus_city_origin}</span> : null}
          </div>
        ) : null}
        {isExcursionTitleRequired ? (
          <label className="text-sm md:col-span-2">
            Escursione*
            {excursionLines.length > 0 ? (
              <select
                className="input-saas mt-1"
                value={form.excursion_title}
                onChange={(event) => setForm((prev) => ({ ...prev, excursion_title: event.target.value }))}
              >
                {excursionLines.map((ex) => (
                  <option key={ex.id} value={ex.name}>{ex.name}</option>
                ))}
              </select>
            ) : (
              <input
                className="input-saas mt-1"
                placeholder="Nome escursione"
                value={form.excursion_title}
                onChange={(event) => setForm((prev) => ({ ...prev, excursion_title: event.target.value }))}
              />
            )}
            {fieldErrors.excursion_title ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.excursion_title}</span> : null}
          </label>
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

        {/* Prezzo concordato */}
        <label className="text-sm">
          Prezzo concordato (€)
          <div className="relative mt-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">€</span>
            <input
              type="number"
              step="0.01"
              min="0"
              max="99999"
              placeholder="0,00"
              className="input-saas pl-7"
              value={form.quoted_price_eur}
              onChange={(event) => setForm((prev) => ({ ...prev, quoted_price_eur: event.target.value }))}
            />
          </div>
          <span className="mt-1 block text-[11px] text-slate-400">Opzionale — serve per il controllo listino lato operatore.</span>
        </label>

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
            {isSnavKind
              ? (form.customer_last_name || "Nome completo")
              : `${form.customer_first_name || "Nome"} ${form.customer_last_name || "Cognome"}`}{" "}
            | {serviceKindLabel} | Pax {form.pax || "0"}
          </p>
          <p>
            {contextLabels.arrivalDateLabel.replace("*", "")} {form.arrival_date} {form.arrival_time} - {contextLabels.departureDateLabel.replace("*", "")} {form.departure_date} {form.departure_time}
          </p>
          {form.transport_code ? <p>{contextLabels.transportCodeLabel.replace("*","")}: {form.transport_code}{form.transport_code_return ? ` / ritorno: ${form.transport_code_return}` : ""}</p> : null}
          {form.notes.trim() ? <p className="line-clamp-2 text-safe-wrap">Note: {form.notes.trim()}</p> : null}
        </div>

        {reviewWarnings.length > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 md:col-span-2">
            <p className="font-semibold">Controlli prima della conferma</p>
            {reviewWarnings.map((warning) => (
              <p key={warning} className="mt-1">
                - {warning}
              </p>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 md:col-span-2">
            <p className="font-semibold">Pronto per la conferma</p>
            <p className="mt-1">I campi principali per questo tipo servizio risultano compilati.</p>
          </div>
        )}

        <button type="button" onClick={() => void submit()} disabled={submitting || !isFormValid} className="btn-primary md:col-span-2 disabled:opacity-60">
          {submitting ? "Creazione in corso..." : "Conferma prenotazione"}
        </button>
      </div>

      <p className="section-subtitle">{message}</p>

      {/* Modal duplicato */}
      {duplicateWarning ? (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16
          }}
          onClick={() => setDuplicateWarning(null)}
        >
          <div
            style={{
              background: "#fff", borderRadius: 16, padding: 28, maxWidth: 440, width: "100%",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>⚠️</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#0f2744", textAlign: "center", marginBottom: 8 }}>
              Pratica già esistente
            </h2>
            <p style={{ color: "#475569", fontSize: 14, textAlign: "center", marginBottom: 20 }}>
              Esiste già una pratica attiva con questo nome e numero di telefono:
            </p>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 16px", marginBottom: 24, fontSize: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
                <span style={{ color: "#64748b", fontWeight: 600 }}>Cliente</span>
                <span style={{ color: "#1e293b" }}>{duplicateWarning.customer_name}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
                <span style={{ color: "#64748b", fontWeight: 600 }}>Data</span>
                <span style={{ color: "#1e293b" }}>{duplicateWarning.date}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
                <span style={{ color: "#64748b", fontWeight: 600 }}>Tipo</span>
                <span style={{ color: "#1e293b" }}>{duplicateWarning.direction}</span>
              </div>
              {duplicateWarning.arrival_date ? (
                <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
                  <span style={{ color: "#64748b", fontWeight: 600 }}>Arrivo</span>
                  <span style={{ color: "#1e293b" }}>{duplicateWarning.arrival_date}</span>
                </div>
              ) : null}
              {duplicateWarning.departure_date ? (
                <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
                  <span style={{ color: "#64748b", fontWeight: 600 }}>Partenza</span>
                  <span style={{ color: "#1e293b" }}>{duplicateWarning.departure_date}</span>
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0" }}>
                <span style={{ color: "#64748b", fontWeight: 600 }}>Hotel</span>
                <span style={{ color: "#1e293b" }}>{duplicateWarning.hotel_name}</span>
              </div>
            </div>
            <p style={{ color: "#475569", fontSize: 13, textAlign: "center", marginBottom: 20 }}>
              Vuoi continuare comunque con l'inserimento?
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                onClick={() => setDuplicateWarning(null)}
                style={{
                  flex: 1, padding: "11px 0", border: "1px solid #d1d5db",
                  borderRadius: 10, background: "#fff", color: "#475569",
                  fontSize: 14, fontWeight: 600, cursor: "pointer"
                }}
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => void submit(true)}
                style={{
                  flex: 1, padding: "11px 0", border: "none",
                  borderRadius: 10, background: "#0f2744", color: "#fff",
                  fontSize: 14, fontWeight: 700, cursor: "pointer"
                }}
              >
                Continua comunque
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
