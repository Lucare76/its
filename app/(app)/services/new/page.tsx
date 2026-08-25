"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateInput } from "@/components/ui";
import {
  buildFerryScheduleOptions,
  type FerryScheduleRow,
  ferryPortLabel,
} from "@/lib/ferry-schedule-options";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { runGuardedSubmit } from "@/lib/guarded-submit";
import {
  useServiceForm,
  useBusCatalog,
  type BookingKind,
  type HotelOption,
} from "./_hooks";
import {
  formatDateItFromIso,
  formatCreatedAtLabel,
  hasReturnLeg,
  practiceNumberHeading,
  createdByLabel,
} from "@/lib/booking-success-summary";

type OpsRole = "admin" | "operator" | "supervisor";

interface AgencyOption {
  id: string;
  name: string;
}

type CreatedBookingSummary = {
  id: string;
  id_return?: string | null;
  round_trip?: boolean;
  created_at?: string | null;
  operator_name?: string | null;
  booking?: {
    practice_number?: string | null;
    customer_name?: string | null;
    pax?: number | null;
    service_label?: string | null;
    arrival_date?: string | null;
    departure_date?: string | null;
    trip_leg?: string | null;
    hotel_name?: string | null;
    agency_name?: string | null;
  } | null;
};

const EXCURSION_PORTS = ["Casamicciola", "Lacco Ameno", "Forio", "Ischia Porto"] as const;

const kindOptions: Array<{ value: BookingKind; label: string }> = [
  { value: "formula_snav", label: "Formula SNAV" },
  { value: "formula_medmar_napoli", label: "Formula MEDMAR — Napoli" },
  { value: "formula_medmar_pozzuoli", label: "Formula MEDMAR — Pozzuoli" },
  { value: "transfer_airport_hotel", label: "Transfer aeroporto → hotel" },
  { value: "transfer_airport_hotel_exclusive", label: "Transfer aeroporto → hotel (esclusivo)" },
  { value: "transfer_airport_hotel_aliscafo", label: "Transfer aeroporto → hotel (aliscafo 🚤)" },
  { value: "transfer_train_hotel", label: "Transfer stazione / bus → hotel" },
  { value: "transfer_train_hotel_exclusive", label: "Transfer stazione / bus → hotel (esclusivo)" },
  { value: "transfer_train_hotel_aliscafo", label: "Transfer stazione / bus → hotel (aliscafo 🚤)" },
  { value: "bus_city_hotel", label: "Linea bus → hotel" },
  { value: "excursion", label: "Escursione" },
  { value: "transfer_port_hotel", label: "Transfer porto → hotel" },
  { value: "transfer_hotel_hotel", label: "Transfer hotel → hotel" },
  { value: "shuttle_hotel", label: "Navetta hotel" },
  { value: "private_island", label: "Servizio Privato sull'Isola" },
];

function isSunday(dateStr: string): boolean {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getDay() === 0;
}

function nextSunday(fromDate: string, skipSame = false): string {
  const [y, m, d] = fromDate.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  const day = date.getDay();
  const daysToAdd = day === 0 ? (skipSame ? 7 : 0) : 7 - day;
  date.setDate(date.getDate() + daysToAdd);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeHotelSearch(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("it")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function bookingContext(kind: BookingKind) {
  if (kind === "formula_snav" || kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli") {
    const label = kind === "formula_snav" ? "SNAV" : kind === "formula_medmar_napoli" ? "MEDMAR Napoli" : "MEDMAR Pozzuoli";
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
  if (kind === "transfer_airport_hotel" || kind === "transfer_airport_hotel_exclusive" || kind === "transfer_airport_hotel_aliscafo") {
    return {
      arrivalDateLabel: "Data volo andata*",
      arrivalTimeLabel: "Ora arrivo volo andata*",
      departureDateLabel: "Data volo ritorno*",
      departureTimeLabel: "Ora partenza volo ritorno*",
      transportCodeLabel: "Numero mezzo andata*",
      transportCodePlaceholder: "Es. volo FR1234",
      transportCodeReturnLabel: "Numero mezzo ritorno*",
      transportCodeReturnPlaceholder: "Es. volo FR5678"
    };
  }
  if (kind === "transfer_train_hotel" || kind === "transfer_train_hotel_exclusive" || kind === "transfer_train_hotel_aliscafo") {
    return {
      arrivalDateLabel: "Data arrivo*",
      arrivalTimeLabel: "Ora arrivo*",
      departureDateLabel: "Data ritorno*",
      departureTimeLabel: "Ora partenza ritorno*",
      transportCodeLabel: "Numero mezzo andata*",
      transportCodePlaceholder: "Es. FRECCIAROSSA 9527 o FlixBus",
      transportCodeReturnLabel: "Numero mezzo ritorno*",
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
  if (kind === "transfer_hotel_hotel") {
    return {
      arrivalDateLabel: "Data andata*",
      arrivalTimeLabel: "Ora andata*",
      departureDateLabel: "Data ritorno*",
      departureTimeLabel: "Ora ritorno*",
      transportCodeLabel: "Riferimento operativo",
      transportCodePlaceholder: "Facoltativo",
      transportCodeReturnLabel: undefined as string | undefined,
      transportCodeReturnPlaceholder: undefined as string | undefined
    };
  }
  if (kind === "shuttle_hotel") {
    return {
      arrivalDateLabel: "Data servizio*",
      arrivalTimeLabel: "Ora inizio*",
      departureDateLabel: "Data fine servizio*",
      departureTimeLabel: "Ora fine*",
      transportCodeLabel: "Riferimento operativo",
      transportCodePlaceholder: "Facoltativo",
      transportCodeReturnLabel: undefined as string | undefined,
      transportCodeReturnPlaceholder: undefined as string | undefined
    };
  }
  if (kind === "private_island") {
    return {
      arrivalDateLabel: "Data servizio*",
      arrivalTimeLabel: "Dalle*",
      departureDateLabel: "Data fine",
      departureTimeLabel: "Alle*",
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

export default function OpsNewBookingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  // Riservato SOLO agli errori (box rosso, vedi Objective 8): nessun testo istruttivo neutro qui,
  // altrimenti verrebbe mostrato in rosso al primo caricamento senza che sia un errore.
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitInFlightRef = useRef(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [role, setRole] = useState<OpsRole | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [hotels, setHotels] = useState<HotelOption[]>([]);
  const [agencies, setAgencies] = useState<AgencyOption[]>([]);
  const [ferryScheduleRows, setFerryScheduleRows] = useState<FerryScheduleRow[]>([]);
  const [dataLoadWarning, setDataLoadWarning] = useState<string | null>(null);
  const [reloadingData, setReloadingData] = useState(false);
  const [createdBooking, setCreatedBooking] = useState<CreatedBookingSummary | null>(null);

  const [addingHotel, setAddingHotel] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [newHotelAddress, setNewHotelAddress] = useState("");
  const [newHotelCity, setNewHotelCity] = useState("");
  const [savingHotel, setSavingHotel] = useState(false);
  const [hotelSearch, setHotelSearch] = useState("");
  const [hotelSearchOpen, setHotelSearchOpen] = useState(false);

  const [addingAgency, setAddingAgency] = useState(false);
  const [newAgencyName, setNewAgencyName] = useState("");
  const [savingAgency, setSavingAgency] = useState(false);

  type DuplicateService = {
    id: string;
    date: string;
    direction: string;
    hotel_name: string;
    agency_name: string | null;
    pax: number | null;
    phone: string | null;
    arrival_date: string | null;
    departure_date: string | null;
  };
  const [duplicateWarning, setDuplicateWarning] = useState<{
    match_type: "exact" | "name_only";
    customer_name: string;
    services: DuplicateService[];
  } | null>(null);

  const {
    form, setForm, fieldErrors, setFieldErrors,
    tripLeg, setTripLeg,
    ferryDepTime, setFerryDepTime,
    excursionLines,
    isSnavKind, isMedmarKind, isSnavMedmar,
    isPrivateIsland, isTransferHotelHotel, isBusOriginRequired,
    isExcursionTitleRequired, isTransportCodeRequired,
    isPhoneRequired, showTransportCodeField,
    showTripLeg, isRoundTrip, showPickupTime,
    snavArrivalOptions, snavDepartureOptions,
    medmarArrivalOptions, medmarDepartureOptions,
    portoArrivo, depRuleInfo, hotelZona,
    normalizedPayload, isFormValid,
    reviewWarnings, resetForm,
  } = useServiceForm({ hotels, ferryScheduleRows, tenantId });

  const handleBusDepartureTimeChange = useCallback((time: string) => {
    setForm((prev) => prev.departure_time === time ? prev : { ...prev, departure_time: time });
  }, [setForm]);

  const {
    busStops, busSearch, setBusSearch,
    busSearchOpen, setBusSearchOpen,
    busLoading, busCatalogLoaded, busCatalogError,
    selectedBusStop, setSelectedBusStop,
    busReturnTime, busReturnTimeLoading,
    replaceError, setReplaceError,
    reset: resetBus,
  } = useBusCatalog({
    bookingKind: form.booking_service_kind,
    hotelId: form.hotel_id,
    accessToken,
    onDepartureTimeChange: handleBusDepartureTimeChange,
  });

  const loadOperationalData = useCallback(async (activeTenantId: string, opts?: { silent?: boolean }) => {
    if (!supabase) return;
    if (!opts?.silent) setDataLoadWarning(null);

    const [hotelRes, agencyRes, snavScheduleRes] = await Promise.all([
      supabase.from("hotels").select("id, name, zone").eq("tenant_id", activeTenantId).order("name").limit(2000),
      supabase.from("agencies").select("id, name").eq("tenant_id", activeTenantId).eq("active", true).order("name"),
      supabase
        .from("ferry_schedules")
        .select("company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to")
        .in("company", ["snav", "medmar"])
    ]);

    const failedParts: string[] = [];
    if (hotelRes.error) failedParts.push("hotel");
    if (agencyRes.error) failedParts.push("agenzie");
    if (snavScheduleRes.error) failedParts.push("orari traghetto");

    setHotels((hotelRes.data ?? []) as HotelOption[]);
    setAgencies((agencyRes.data ?? []) as AgencyOption[]);
    setFerryScheduleRows((snavScheduleRes.data ?? []) as FerryScheduleRow[]);

    if (failedParts.length > 0) {
      setDataLoadWarning(`Caricamento incompleto (${failedParts.join(", ")}). Riprova o ricarica la pagina prima di procedere.`);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      if (session.mode === "demo" || !hasSupabaseEnv || !supabase || !session.tenantId) {
        setMessage("Disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }
      if (session.role !== "admin" && session.role !== "operator" && session.role !== "supervisor") {
        setMessage("Ruolo non autorizzato per questa sezione.");
        setLoading(false);
        return;
      }

      setRole(session.role as OpsRole);
      setTenantId(session.tenantId);
      const { data: tokenData } = await supabase.auth.getSession();
      setAccessToken(tokenData.session?.access_token ?? null);

      await loadOperationalData(session.tenantId);
      if (!active) return;

      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [setForm, loadOperationalData]);

  const retryLoadOperationalData = useCallback(async () => {
    if (!tenantId) return;
    setReloadingData(true);
    await loadOperationalData(tenantId);
    setReloadingData(false);
  }, [tenantId, loadOperationalData]);

  const createHotel = async () => {
    if (!supabase || !tenantId || !newHotelName.trim()) return;
    setSavingHotel(true);
    const { data, error } = await supabase
      .from("hotels")
      .insert({ tenant_id: tenantId, name: newHotelName.trim().toUpperCase(), address: newHotelAddress.trim() || "", city: newHotelCity.trim() || null, lat: 0, lng: 0, zone: "" })
      .select("id, name, zone").single();
    setSavingHotel(false);
    if (error || !data?.id) { setMessage(`Errore creazione hotel: ${error?.message ?? "sconosciuto"}`); return; }
    const newHotel = { id: data.id, name: data.name, zone: data.zone ?? null } as HotelOption;
    setHotels((prev) => [...prev, newHotel].sort((a, b) => a.name.localeCompare(b.name, "it")));
    setForm((prev) => ({ ...prev, hotel_id: data.id }));
    setAddingHotel(false);
    setNewHotelName(""); setNewHotelAddress(""); setNewHotelCity("");
  };

  const createAgency = async () => {
    if (!supabase || !tenantId || !newAgencyName.trim()) return;
    setSavingAgency(true);
    const { data, error } = await supabase
      .from("agencies")
      .insert({ tenant_id: tenantId, name: newAgencyName.trim(), active: true, notes: "" })
      .select("id, name").single();
    setSavingAgency(false);
    if (error || !data?.id) { setMessage(`Errore creazione agenzia: ${error?.message ?? "sconosciuto"}`); return; }
    const newAgency = { id: data.id, name: data.name } as AgencyOption;
    setAgencies((prev) => [...prev, newAgency].sort((a, b) => a.name.localeCompare(b.name, "it")));
    setForm((prev) => ({ ...prev, agency_id: data.id }));
    setAddingAgency(false);
    setNewAgencyName("");
  };

  const hasHotels = hotels.length > 0;
  const selectedHotel = hotels.find((hotel) => hotel.id === form.hotel_id) ?? null;
  const normalizedHotelSearch = normalizeHotelSearch(hotelSearch);
  const hotelSuggestions = normalizedHotelSearch
    ? hotels
        .filter((hotel) => normalizeHotelSearch(hotel.name).includes(normalizedHotelSearch))
        .sort((left, right) => {
          const leftName = normalizeHotelSearch(left.name);
          const rightName = normalizeHotelSearch(right.name);
          const leftStarts = leftName.startsWith(normalizedHotelSearch);
          const rightStarts = rightName.startsWith(normalizedHotelSearch);
          if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
          return leftName.indexOf(normalizedHotelSearch) - rightName.indexOf(normalizedHotelSearch)
            || left.name.localeCompare(right.name, "it");
        })
        .slice(0, 20)
    : hotels.slice(0, 20);
  const selectedKind = form.booking_service_kind;
  const serviceKindLabel = useMemo(() => kindOptions.find((item) => item.value === selectedKind)?.label ?? "Servizio", [selectedKind]);
  const contextLabels = useMemo(() => bookingContext(selectedKind), [selectedKind]);
  const selectBookingKind = (kind: BookingKind) => {
    setForm((prev) => ({
      ...prev,
      booking_service_kind: kind,
      arrival_date: kind === "bus_city_hotel" ? nextSunday(prev.arrival_date) : prev.arrival_date,
      departure_date: kind === "bus_city_hotel" ? nextSunday(prev.departure_date, true) : prev.departure_date,
      arrival_time: kind === "formula_snav" ? (snavArrivalOptions[0]?.time ?? prev.arrival_time) : kind === "formula_medmar_napoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", prev.arrival_date, { company: "medmar", departurePort: "napoli_beverello" })[0]?.time ?? prev.arrival_time) : kind === "formula_medmar_pozzuoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", prev.arrival_date, { company: "medmar", departurePort: "pozzuoli" })[0]?.time ?? prev.arrival_time) : prev.arrival_time,
      departure_time: kind === "formula_snav" ? (snavDepartureOptions[0]?.time ?? prev.departure_time) : kind === "formula_medmar_napoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", prev.departure_date, { company: "medmar", arrivalPort: "napoli_beverello" })[0]?.time ?? prev.departure_time) : kind === "formula_medmar_pozzuoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", prev.departure_date, { company: "medmar", arrivalPort: "pozzuoli" })[0]?.time ?? prev.departure_time) : prev.departure_time
    }));
    if (kind !== "bus_city_hotel") resetBus();
  };

  const doSubmit = async () => {
    if (!accessToken) { setMessage("Sessione non valida. Rifai login."); return; }
    const parsed = agencyBookingCreateSchema.safeParse(normalizedPayload);
    if (!parsed.success) {
      const nextFieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !nextFieldErrors[key]) nextFieldErrors[key] = issue.message;
      }
      setFieldErrors(nextFieldErrors);
      setMessage(parsed.error.issues[0]?.message ?? "Dati non validi.");
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    const extraFields = isSnavMedmar ? {
      meeting_point: tripLeg !== "return_only" ? portoArrivo ?? undefined : undefined,
      ferry_dep_time: tripLeg !== "outbound_only" ? ferryDepTime : undefined,
      porto_partenza: tripLeg !== "outbound_only" ? depRuleInfo?.porto ?? undefined : undefined,
    } : isExcursionTitleRequired ? {
      excursion_departure_port: form.excursion_departure_port || undefined,
      excursion_pickup_port: form.excursion_pickup_port || undefined,
    } : {};

    const response = await fetch("/api/ops/new-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...parsed.data, ...extraFields })
    });
    const body = (await response.json().catch(() => null)) as (CreatedBookingSummary & { ok?: boolean; error?: string }) | null;
    setSubmitting(false);

    if (!response.ok || !body?.id) {
      setMessage(body?.error ?? "Creazione prenotazione non riuscita.");
      return;
    }

    // Il successo e' rappresentato SOLO dalla card verde (createdBooking), mai da `message`:
    // `message` resta riservato agli errori (rosso), coerente con la semantica colori del gestionale.
    setMessage("");
    setCreatedBooking({
      id: body.id,
      id_return: body.id_return ?? null,
      round_trip: body.round_trip,
      created_at: body.created_at ?? null,
      operator_name: body.operator_name ?? null,
      booking: body.booking ?? null,
    });
  };

  const resetForAnotherBooking = () => {
    setCreatedBooking(null);
    setDuplicateWarning(null);
    setReplaceError(null);
    setFieldErrors({});
    resetForm(hotels[0]?.id ?? "");
    resetBus();
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async (force = false) => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
    await runGuardedSubmit(submitting, setSubmitting, async () => {
      if (reviewWarnings.length > 0) {
        const errs: Record<string, string> = {};
        if (isSnavKind) {
          if (!form.customer_last_name.trim()) errs.customer_last_name = "Campo obbligatorio";
        } else {
          if (!form.customer_first_name.trim()) errs.customer_first_name = "Campo obbligatorio";
          if (!form.customer_last_name.trim()) errs.customer_last_name = "Campo obbligatorio";
        }
        if (isPhoneRequired && !form.customer_phone.trim()) errs.customer_phone = "Campo obbligatorio";
        if (!form.pax || isNaN(Number(form.pax)) || Number(form.pax) < 1) errs.pax = "Minimo 1 pax";
        if (Number(form.pet_count || "0") > 0 && !form.pet_notes.trim()) errs.pet_notes = "Indica tipo/taglia animale";
        if (!form.hotel_id && !isPrivateIsland) errs.hotel_id = "Seleziona la struttura";
        if (!(showTripLeg && tripLeg === "return_only") && !form.arrival_date) errs.arrival_date = "Campo obbligatorio";
        if (!(showTripLeg && tripLeg === "return_only") && !form.arrival_time) errs.arrival_time = "Campo obbligatorio";
        if (!(showTripLeg && tripLeg === "outbound_only") && !form.departure_date) errs.departure_date = "Campo obbligatorio";
        if (!(showTripLeg && tripLeg === "outbound_only") && !form.departure_time) errs.departure_time = "Campo obbligatorio";
        if (isTransportCodeRequired && tripLeg !== "return_only" && !form.transport_code.trim()) errs.transport_code = "Campo obbligatorio";
        if (isTransportCodeRequired && tripLeg !== "outbound_only" && contextLabels.transportCodeReturnLabel && !form.transport_code_return.trim()) errs.transport_code_return = "Campo obbligatorio";
        if (isBusOriginRequired && !form.bus_city_origin.trim()) errs.bus_city_origin = "Campo obbligatorio";
        if (isExcursionTitleRequired && !form.excursion_title.trim()) errs.excursion_title = "Campo obbligatorio";
        if (isExcursionTitleRequired && !form.excursion_departure_port) errs.excursion_departure_port = "Campo obbligatorio";
        if (isExcursionTitleRequired && !form.excursion_pickup_port) errs.excursion_pickup_port = "Campo obbligatorio";
        setFieldErrors(errs);
        setMessage("Compila tutti i campi obbligatori (*) prima di continuare.");
        return;
      }

      const parsed = agencyBookingCreateSchema.safeParse(normalizedPayload);
      if (!parsed.success) { await doSubmit(); return; }

      if (!force && accessToken) {
        const customerName = isSnavKind
          ? form.customer_last_name.trim()
          : `${form.customer_first_name.trim()} ${form.customer_last_name.trim()}`.trim();
        const phone = form.customer_phone.trim();
        if (customerName.length >= 2) {
          try {
            const res = await fetch(
              `/api/agency/check-duplicate?name=${encodeURIComponent(customerName)}&phone=${encodeURIComponent(phone)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const dupBody = await res.json() as {
              found: boolean;
              match_type?: "exact" | "name_only";
              services?: Array<{ id: string; date: string; direction: string; hotel_name: string; agency_name: string | null; pax: number | null; phone: string | null; arrival_date: string | null; departure_date: string | null; }>;
            };
            if (dupBody.found && dupBody.services && dupBody.services.length > 0) {
              setReplaceError(null);
              setDuplicateWarning({
                match_type: dupBody.match_type ?? "exact",
                customer_name: customerName,
                services: dupBody.services.map((s) => ({
                  ...s,
                  direction: s.direction === "arrival" ? "Arrivo" : "Partenza",
                })),
              });
              return;
            }
          } catch { /* se il check fallisce, procedi */ }
        }
      }
      setDuplicateWarning(null);
      await doSubmit();
    });
    } finally {
      submitInFlightRef.current = false;
    }
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento...</div>;
  if (!hasSupabaseEnv || !supabase) return <div className="card p-4 text-sm text-slate-500">Supabase non configurato.</div>;

  const createdAtLabel = formatCreatedAtLabel(createdBooking?.created_at);
  const bookingHasReturnLeg = createdBooking ? hasReturnLeg({ id_return: createdBooking.id_return, trip_leg: createdBooking.booking?.trip_leg }) : false;

  return (
    <section className="mx-auto w-full max-w-[1400px] page-section">
      <div className="section-head mb-1">
        <h1 className="section-title">Nuova prenotazione</h1>
        <p className="section-subtitle">Inserimento diretto da {role === "admin" ? "amministratore" : role === "supervisor" ? "supervisore" : "operatore"}.</p>
      </div>
      {createdBooking ? (
        <article className="card mb-4 space-y-4 border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-950" data-testid="booking-success-card">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">✅ Prenotazione inserita correttamente</p>
            <h2 className="mt-1 text-xl font-extrabold text-slate-950">
              {practiceNumberHeading(createdBooking.booking?.practice_number)}
            </h2>
            <p className="mt-1 text-emerald-800">
              {createdBooking.booking?.customer_name ?? "Cliente N/D"} — {createdBooking.booking?.pax ?? "-"} pax
            </p>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs font-semibold text-emerald-700">Tipologia/tratta</dt><dd className="font-bold text-slate-950">{createdBooking.booking?.service_label ?? serviceKindLabel}</dd></div>
            <div><dt className="text-xs font-semibold text-emerald-700">Andata</dt><dd className="font-bold text-slate-950">{formatDateItFromIso(createdBooking.booking?.arrival_date) ?? "-"}</dd></div>
            {bookingHasReturnLeg && createdBooking.booking?.departure_date ? (
              <div><dt className="text-xs font-semibold text-emerald-700">Ritorno</dt><dd className="font-bold text-slate-950">{formatDateItFromIso(createdBooking.booking.departure_date)}</dd></div>
            ) : null}
            <div><dt className="text-xs font-semibold text-emerald-700">Operatore</dt><dd className="font-bold text-slate-950">{createdByLabel(createdBooking.operator_name)}</dd></div>
            <div><dt className="text-xs font-semibold text-emerald-700">Data e ora</dt><dd className="font-bold text-slate-950">{createdAtLabel ?? "-"}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => router.push("/inbox")} className="btn-primary px-4 py-2 text-sm">Torna alle prenotazioni</button>
            <button type="button" onClick={resetForAnotherBooking} className="btn-secondary px-4 py-2 text-sm">Inserisci altra prenotazione</button>
            <Link href={`/services/${createdBooking.id}/edit`} className="btn-secondary px-4 py-2 text-sm">Apri pratica</Link>
          </div>
        </article>
      ) : null}
      <div className="mb-4 flex flex-col gap-3 border-b border-slate-200 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 overflow-x-auto">
          <button type="button" className="border-b-2 border-indigo-600 px-5 py-3 text-sm font-bold text-indigo-700">Inserimento manuale</button>
          <Link href="/inbox" className="border-b-2 border-transparent px-5 py-3 text-sm font-semibold text-slate-500 hover:border-indigo-200 hover:text-indigo-700">Da agenzia / Automatiche</Link>
        </div>
        <Link href="/inbox" className="mb-2 text-sm font-semibold text-indigo-600 hover:text-indigo-800">Apri coda automatiche →</Link>
      </div>
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">i</span>
        <p>Le prenotazioni ricevute da <strong>ALESTE VIAGGI</strong> e dalle altre agenzie vengono precompilate automaticamente. Verifica i dati nella coda prima di confermare.</p>
      </div>

      {/*
        Il form operativo resta montato SOLO finche' non esiste una prenotazione appena creata:
        dopo un successo (createdBooking valorizzato) non deve restare utilizzabile ne' mostrare
        piu' "Pronto per la conferma"/"Conferma prenotazione" — l'unico modo per tornare al form
        e' cliccare "Inserisci altra prenotazione" (resetForAnotherBooking), che azzera createdBooking.
      */}
      {!createdBooking && (
      <>
      {dataLoadWarning ? (
        <article className="card space-y-2 border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 mb-4">
          <p className="font-semibold">{dataLoadWarning}</p>
          <button type="button" onClick={() => void retryLoadOperationalData()} disabled={reloadingData} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-60">
            {reloadingData ? "Ricaricamento..." : "Riprova a caricare i dati"}
          </button>
        </article>
      ) : null}

      {!hasHotels && !dataLoadWarning ? (
        <article className="card space-y-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 mb-4">
          <p className="font-semibold">Nessun hotel disponibile.</p>
          <Link href="/hotels" className="btn-secondary px-3 py-1.5 text-xs">Apri hotel</Link>
        </article>
      ) : null}

      <div className="grid w-full items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-5">

        {/* Tipo servizio */}
        <div className="pms-panel order-1 grid gap-4 p-5 md:grid-cols-2">
        <div className="md:col-span-2">
          <div className="pms-step-title"><span className="pms-step-number">1</span> Tipo di servizio</div>
        </div>
        <label className="text-sm md:col-span-2">
          Tipo servizio*
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {([
              ["formula_medmar_napoli", "MEDMAR Napoli", "⛴"],
              ["formula_medmar_pozzuoli", "MEDMAR Pozzuoli", "⛴"],
              ["formula_snav", "SNAV", "🚤"],
              ["transfer_airport_hotel", "Aeroporto", "✈"],
              ["transfer_train_hotel", "Stazione / Bus", "▣"],
              ["transfer_port_hotel", "Porto / Altro", "•••"],
            ] as const).map(([value, label, icon]) => (
              <button key={value} type="button" onClick={() => selectBookingKind(value)} className={`pms-segment gap-2 ${selectedKind === value ? "pms-segment-active" : ""}`}>
                <span>{icon}</span><span>{label}</span>
              </button>
            ))}
          </div>
          <span className="mt-3 block text-xs font-medium text-slate-500">Tutti i servizi</span>
          <select
            className="input-saas mt-1"
            value={form.booking_service_kind}
            onChange={(e) => selectBookingKind(e.target.value as BookingKind)}
          >
            {kindOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        </div>

        {/* Nome cliente */}
        <div className="pms-panel order-2 grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-12">
        <div className="md:col-span-2 lg:col-span-12">
          <div className="pms-step-title"><span className="pms-step-number">2</span> Cliente e prenotazione</div>
        </div>
        {isSnavKind ? (
          <label className="text-sm md:col-span-2 lg:col-span-4">
            Nome completo cliente*
            <input className="input-saas mt-1" placeholder="Es. Mario Rossi"
              value={form.customer_last_name}
              onChange={(e) => setForm((prev) => ({ ...prev, customer_last_name: e.target.value, customer_first_name: "" }))}
            />
            {fieldErrors.customer_last_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_last_name}</span> : null}
          </label>
        ) : (
          <>
            <label className="text-sm lg:col-span-2">
              Nome*
              <input className="input-saas mt-1" value={form.customer_first_name}
                onChange={(e) => setForm((prev) => ({ ...prev, customer_first_name: e.target.value }))}
              />
              {fieldErrors.customer_first_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_first_name}</span> : null}
            </label>
            <label className="text-sm lg:col-span-2">
              Cognome*
              <input className="input-saas mt-1" value={form.customer_last_name}
                onChange={(e) => setForm((prev) => ({ ...prev, customer_last_name: e.target.value }))}
              />
              {fieldErrors.customer_last_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_last_name}</span> : null}
            </label>
          </>
        )}

        <label className="text-sm lg:col-span-2">
          {isPhoneRequired ? "Telefono*" : "Telefono"}
          <input className="input-saas mt-1" value={form.customer_phone}
            onChange={(e) => setForm((prev) => ({ ...prev, customer_phone: e.target.value }))}
          />
          {fieldErrors.customer_phone ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_phone}</span> : null}
        </label>

        <label className={`text-sm lg:col-span-2 ${isMedmarKind ? "hidden" : ""}`}>
          Pax prezzo pieno*
          <input type="number" min={1} max={50} className="input-saas mt-1" value={form.pax}
            onChange={(e) => setForm((prev) => ({ ...prev, pax: e.target.value }))}
          />
          <span className="mt-1 block text-xs text-slate-500">2+ anni: prezzo pieno.</span>
          {fieldErrors.pax ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.pax}</span> : null}
        </label>
        {isMedmarKind ? (
          <div className="md:col-span-2 lg:col-span-4 rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-4 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-indigo-950">Passeggeri Formula MEDMAR</p>
                <p className="text-xs text-indigo-700">Indicare i passeggeri suddivisi per fascia di età.</p>
              </div>
              <span className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-black text-indigo-700 shadow-sm">Totale {form.pax}</span>
            </div>
            <div className="grid gap-2">
              {([
                ["medmar_infant_count", "Infant", "0-4 anni"],
                ["medmar_child_count", "Bambino", "4-12 anni"],
                ["medmar_adult_count", "Adulto", "12+ anni"],
              ] as const).map(([field, label, ages]) => (
                <label key={field} className="flex items-center justify-between gap-3 rounded-2xl border border-indigo-100 bg-white px-3 py-2.5 text-sm shadow-sm">
                  <span className="min-w-0">
                    <span className="block whitespace-nowrap font-black text-slate-950">{label}</span>
                    <span className="block whitespace-nowrap text-xs font-semibold text-slate-500">{ages}</span>
                  </span>
                  <input type="number" min={0} max={16} className="h-11 w-20 rounded-xl border border-slate-200 bg-slate-50 px-2 text-center text-base font-black text-slate-950 outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100" value={form[field]}
                    onChange={(event) => setForm((prev) => {
                      const next = { ...prev, [field]: event.target.value };
                      const total = Number(next.medmar_infant_count || 0) + Number(next.medmar_child_count || 0) + Number(next.medmar_adult_count || 0);
                      return { ...next, pax: String(total) };
                    })}
                  />
                </label>
              ))}
            </div>
          </div>
        ) : null}
        <label className="text-sm lg:col-span-4">
          Agenzia
          <select className="input-saas mt-1" value={form.agency_id} onChange={(e) => setForm((prev) => ({ ...prev, agency_id: e.target.value }))}>
            <option value="">Privato / nessuna agenzia</option>
            {agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
          </select>
        </label>
        <label className="text-sm md:col-span-2 lg:col-span-6">
          Email cliente <span className="font-normal text-slate-400">(facoltativa per privati)</span>
          <input type="email" className="input-saas mt-1" data-no-uppercase placeholder="cliente@email.it" value={form.customer_email}
            onChange={(event) => setForm((prev) => ({ ...prev, customer_email: event.target.value }))}
          />
          {fieldErrors.customer_email ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_email}</span> : null}
        </label>
        <details className="md:col-span-2 lg:col-span-12 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">Passeggeri speciali e animali</summary>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          Infant 0-1,99 anni
          <input type="number" min={0} max={16} className="input-saas mt-1" value={form.infant_count}
            onChange={(e) => setForm((prev) => ({ ...prev, infant_count: e.target.value }))}
          />
          <span className="mt-1 block text-xs text-slate-500">Quota fissa EUR 2,50 cad.</span>
          {fieldErrors.infant_count ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.infant_count}</span> : null}
        </label>
        <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
          <label className="text-sm">
            Animali piccola taglia
            <input type="number" min={0} max={10} className="input-saas mt-1" value={form.pet_count}
              onChange={(e) => setForm((prev) => ({ ...prev, pet_count: e.target.value }))}
            />
            <span className="mt-1 block text-xs text-slate-500">Solo fino a 10 kg. Biglietto a cura del cliente in biglietteria.</span>
            {fieldErrors.pet_count ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.pet_count}</span> : null}
          </label>
          <label className="text-sm">
            Note animali
            <input className="input-saas mt-1" placeholder="Es. cane 6 kg nel trasportino" value={form.pet_notes}
              onChange={(e) => setForm((prev) => ({ ...prev, pet_notes: e.target.value }))}
            />
            {fieldErrors.pet_notes ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.pet_notes}</span> : null}
          </label>
        </div>
          </div>
        </details>

        {/* Hotel */}
        <div className="text-sm md:col-span-2 lg:col-span-12">
          <span>Hotel / Struttura{isPrivateIsland ? "" : "*"}</span>
          {addingHotel ? (
            <div className="mt-2 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
              <input className="input-saas" placeholder="Nome hotel*" value={newHotelName} onChange={(e) => setNewHotelName(e.target.value)} />
              <input className="input-saas" placeholder="Indirizzo" value={newHotelAddress} onChange={(e) => setNewHotelAddress(e.target.value)} />
              <input className="input-saas" placeholder="Città" value={newHotelCity} onChange={(e) => setNewHotelCity(e.target.value)} />
              <button type="button" onClick={() => void createHotel()} disabled={savingHotel || !newHotelName.trim()} className="btn-primary w-full py-1.5 text-xs disabled:opacity-60">
                {savingHotel ? "Salvataggio..." : "Salva hotel"}
              </button>
              <button type="button" onClick={() => setAddingHotel(false)} className="btn-secondary w-full py-1.5 text-xs">Annulla</button>
            </div>
          ) : (
            <div className="relative mt-1">
              <input
                className="input-saas"
                role="combobox"
                aria-expanded={hotelSearchOpen}
                aria-controls="hotel-suggestions"
                placeholder="Scrivi le iniziali della struttura..."
                value={hotelSearchOpen ? hotelSearch : selectedHotel?.name ?? hotelSearch}
                onFocus={() => { setHotelSearch(selectedHotel?.name ?? hotelSearch); setHotelSearchOpen(true); }}
                onChange={(event) => {
                  setHotelSearch(event.target.value);
                  setHotelSearchOpen(true);
                  setForm((prev) => ({ ...prev, hotel_id: "" }));
                }}
              />
              {hotelSearchOpen ? (
                <div id="hotel-suggestions" className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                  {hotelSuggestions.map((hotel) => (
                    <button
                      key={hotel.id}
                      type="button"
                      className="block w-full rounded-lg px-3 py-2 text-left hover:bg-blue-50"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setForm((prev) => ({ ...prev, hotel_id: hotel.id }));
                        setHotelSearch(hotel.name);
                        setHotelSearchOpen(false);
                        setFieldErrors((prev) => { const next = { ...prev }; delete next.hotel_id; return next; });
                      }}
                    >
                      <span className="font-medium">{hotel.name}</span>{hotel.zone ? <span className="ml-2 text-xs text-slate-500">{hotel.zone}</span> : null}
                    </button>
                  ))}
                  {normalizedHotelSearch && hotelSuggestions.length === 0 ? (
                    <button
                      type="button"
                      className="block w-full rounded-lg px-3 py-2 text-left font-medium text-blue-700 hover:bg-blue-50"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setNewHotelName(hotelSearch.trim());
                        setAddingHotel(true);
                        setHotelSearchOpen(false);
                      }}
                    >
                      + Aggiungi struttura “{hotelSearch.trim()}”
                    </button>
                  ) : null}
                  {hotelSuggestions.length === 0 && !normalizedHotelSearch ? <p className="px-3 py-2 text-slate-500">Inizia a scrivere il nome.</p> : null}
                </div>
              ) : null}
              {fieldErrors.hotel_id ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.hotel_id}</span> : null}
            </div>
          )}
        </div>

        {/* Hotel destinazione (transfer_hotel_hotel) */}
        {isTransferHotelHotel ? (
          <div className="text-sm md:col-span-2 lg:col-span-6">
            <span>Hotel destinazione*</span>
            <select
              className="input-saas mt-1"
              value={form.hotel_dest_id}
              onChange={(e) => setForm((prev) => ({ ...prev, hotel_dest_id: e.target.value }))}
            >
              <option value="">— Seleziona hotel destinazione —</option>
              {hotels.filter((h) => h.id !== form.hotel_id).map((hotel) => (
                <option key={hotel.id} value={hotel.id}>{hotel.name}{hotel.zone ? ` - ${hotel.zone}` : ""}</option>
              ))}
            </select>
          </div>
        ) : null}
        </div>

        {/* Selettore tratta A/R */}
        <div className="pms-panel order-3 grid gap-4 p-5 md:grid-cols-2">
        <div className="md:col-span-2">
          <div className="pms-step-title"><span className="pms-step-number">3</span> Tratte</div>
        </div>
        {showTripLeg ? (
          <div className="md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Tratta</span>
            <div className="mt-1 flex gap-2">
              {([
                { value: "outbound_only", label: "Solo arrivo" },
                { value: "round_trip", label: "Andata e ritorno" },
                { value: "return_only", label: "Solo partenza" },
              ] as const).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setTripLeg(value);
                    if (value === "outbound_only") {
                      setForm((prev) => ({ ...prev, departure_date: prev.arrival_date, departure_time: prev.arrival_time }));
                    } else if (value === "return_only") {
                      setForm((prev) => ({ ...prev, arrival_date: prev.departure_date, arrival_time: prev.departure_time }));
                    }
                  }}
                  className={`flex-1 rounded-xl border py-2.5 text-xs font-semibold transition ${tripLeg === value ? "border-indigo-600 bg-indigo-600 text-white shadow-sm" : "border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-700"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Date/orari: layout speciale per private_island */}
        {isPrivateIsland ? (
          <div className="md:col-span-2 grid grid-cols-3 gap-3">
            <label className="text-sm">
              {contextLabels.arrivalDateLabel}
              <DateInput className={`input-saas mt-1${fieldErrors.arrival_date ? " border-rose-400" : ""}`} value={form.arrival_date}
                onChange={(iso) => {
                  setForm((prev) => ({ ...prev, arrival_date: iso, departure_date: iso }));
                  setFieldErrors((prev) => { const n = { ...prev }; delete n.arrival_date; return n; });
                }}
              />
              {fieldErrors.arrival_date ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.arrival_date}</span> : null}
            </label>
            <label className="text-sm">
              {contextLabels.arrivalTimeLabel}
              <input type="time" className={`input-saas mt-1${fieldErrors.arrival_time ? " border-rose-400" : ""}`} value={form.arrival_time}
                onChange={(e) => { setForm((prev) => ({ ...prev, arrival_time: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.arrival_time; return n; }); }}
              />
              {fieldErrors.arrival_time ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.arrival_time}</span> : null}
            </label>
            <label className="text-sm">
              {contextLabels.departureTimeLabel}
              <input type="time" className={`input-saas mt-1${fieldErrors.departure_time ? " border-rose-400" : ""}`} value={form.departure_time}
                onChange={(e) => { setForm((prev) => ({ ...prev, departure_time: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.departure_time; return n; }); }}
              />
              {fieldErrors.departure_time ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.departure_time}</span> : null}
            </label>
          </div>
        ) : (
          <>
            {/* Date arrivo */}
            {!(showTripLeg && tripLeg === "return_only") && <div className="md:col-span-2 grid grid-cols-1 items-start gap-4 rounded-2xl border border-blue-100 bg-blue-50/40 p-4 sm:grid-cols-2">
              <p className="col-span-2 text-sm font-extrabold uppercase tracking-wide text-blue-700">↓ Arrivo</p>
              <label className="block min-w-0 text-sm">
                <span className="mb-1 block min-h-5">{contextLabels.arrivalDateLabel}</span>
                <DateInput className={`input-saas mt-1${fieldErrors.arrival_date ? " border-rose-400" : ""}`} value={form.arrival_date}
                  onChange={(iso) => {
                    const newDate = iso;
                    setForm((prev) => ({
                      ...prev, arrival_date: newDate,
                      departure_date: prev.booking_service_kind === "excursion" || prev.departure_date < newDate ? newDate : prev.departure_date
                    }));
                    setFieldErrors((prev) => { const n = { ...prev }; delete n.arrival_date; return n; });
                  }}
                />
                {fieldErrors.arrival_date ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.arrival_date}</span> : null}
                {selectedKind === "bus_city_hotel" && form.arrival_date && !isSunday(form.arrival_date) ? (
                  <span className="mt-1 block text-xs text-amber-600">Le linee bus operano solo la domenica.</span>
                ) : null}
              </label>
              <label className="block min-w-0 text-sm">
                <span className="mb-1 block min-h-5">{isSnavMedmar ? "Orario traghetto arrivo*" : contextLabels.arrivalTimeLabel}</span>
                {isSnavMedmar ? (
                  <select className="input-saas mt-1" value={form.arrival_time} onChange={(e) => setForm((prev) => ({ ...prev, arrival_time: e.target.value }))}>
                    {isSnavKind
                      ? snavArrivalOptions.map(({ time, porto }) => (
                        <option key={time} value={time}>{time} — {ferryPortLabel(porto)}</option>
                      ))
                      : medmarArrivalOptions.map(({ time, porto }) => (
                        <option key={time} value={time}>{time} — {ferryPortLabel(porto)}</option>
                      ))
                    }
                  </select>
                ) : (
                  <>
                    <input type="time" className={`input-saas mt-1${fieldErrors.arrival_time ? " border-rose-400" : ""}`} value={form.arrival_time} onChange={(e) => { setForm((prev) => ({ ...prev, arrival_time: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.arrival_time; return n; }); }} />
                    {fieldErrors.arrival_time ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.arrival_time}</span> : null}
                  </>
                )}
              </label>
            </div>}

            {/* Date ritorno */}
            {!(showTripLeg && tripLeg === "outbound_only") && <div className="md:col-span-2 grid grid-cols-1 items-start gap-4 rounded-2xl border border-violet-100 bg-violet-50/40 p-4 sm:grid-cols-2">
              <p className="col-span-2 text-sm font-extrabold uppercase tracking-wide text-violet-700">↑ Partenza</p>
              <label className="block min-w-0 text-sm">
                <span className="mb-1 block min-h-5">{contextLabels.departureDateLabel}</span>
                <DateInput className={`input-saas mt-1${fieldErrors.departure_date ? " border-rose-400" : selectedKind === "bus_city_hotel" && form.departure_date && !isSunday(form.departure_date) ? " border-amber-400" : ""}`}
                  value={form.departure_date} min={form.arrival_date}
                  onChange={(iso) => { setForm((prev) => ({ ...prev, departure_date: iso })); setFieldErrors((prev) => { const n = { ...prev }; delete n.departure_date; return n; }); }}
                />
                {fieldErrors.departure_date ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.departure_date}</span> : null}
                {selectedKind === "bus_city_hotel" && form.departure_date && !isSunday(form.departure_date) ? (
                  <span className="mt-1 block text-xs text-amber-600">Le linee bus operano solo la domenica.</span>
                ) : null}
              </label>
              <label className="block min-w-0 text-sm">
                <span className="mb-1 block min-h-5">{isSnavMedmar ? "Orario traghetto partenza*" : contextLabels.departureTimeLabel}</span>
                {isSnavMedmar ? (
                  <select
                    className="input-saas mt-1"
                    value={ferryDepTime}
                    onChange={(e) => setFerryDepTime(e.target.value)}
                  >
                    {isSnavKind
                      ? snavDepartureOptions.map(({ time, porto }) => (
                        <option key={time} value={time}>{time} — {ferryPortLabel(porto)}</option>
                      ))
                      : medmarDepartureOptions.map(({ time, porto }) => (
                        <option key={time} value={time}>{time} — {ferryPortLabel(porto)}</option>
                      ))
                    }
                  </select>
                ) : (
                  <>
                    <input type="time" className={`input-saas mt-1${fieldErrors.departure_time ? " border-rose-400" : ""}`} value={form.departure_time} onChange={(e) => { setForm((prev) => ({ ...prev, departure_time: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.departure_time; return n; }); }} />
                    {fieldErrors.departure_time ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.departure_time}</span> : null}
                  </>
                )}
              </label>
            </div>}
          </>
        )}

        {/* Porto e prelievo auto-calcolati per SNAV/MEDMAR */}
        {isSnavMedmar && (
          <div className="md:col-span-2 grid grid-cols-2 gap-3">
            {tripLeg !== "return_only" ? (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs">
              <p className="font-semibold text-indigo-700 mb-0.5">Porto arrivo a Ischia</p>
              <p className="text-indigo-900 font-bold text-sm">{portoArrivo ?? "—"}</p>
              <p className="text-indigo-500 mt-0.5">Orario traghetto: {form.arrival_time}</p>
            </div>
            ) : null}
            {tripLeg !== "outbound_only" ? (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs">
              <p className="font-semibold text-emerald-700 mb-0.5">Porto partenza / Prelievo</p>
              {depRuleInfo ? (
                <>
                  <p className="text-emerald-900 font-bold text-sm">{depRuleInfo.porto}</p>
                  <p className="text-emerald-600 mt-0.5">
                    Prelievo hotel: <span className="font-bold">{depRuleInfo.pickup ?? "—"}</span>
                    <span className="ml-1 text-emerald-400">(zona {hotelZona})</span>
                  </p>
                </>
              ) : (
                <p className="text-emerald-500">Seleziona orario traghetto</p>
              )}
            </div>
            ) : null}
          </div>
        )}

        {/* Orario prelevamento hotel */}
        {showPickupTime ? (
          <div className={`md:col-span-2 grid gap-3 ${isRoundTrip || isExcursionTitleRequired ? "grid-cols-2" : "grid-cols-1"}`}>
            <label className="text-sm">
              {isRoundTrip || isExcursionTitleRequired ? "Prelevamento andata" : "Orario prelevamento hotel"}
              <input type="time" className="input-saas mt-1" value={form.pickup_time_outbound}
                onChange={(e) => setForm((prev) => ({ ...prev, pickup_time_outbound: e.target.value }))}
              />
              <span className="mt-1 block text-xs text-slate-400">Facoltativo.</span>
            </label>
            {isRoundTrip || isExcursionTitleRequired ? (
              <label className="text-sm">
                Prelevamento ritorno
                <input type="time" className="input-saas mt-1" value={form.pickup_time_return}
                  onChange={(e) => setForm((prev) => ({ ...prev, pickup_time_return: e.target.value }))}
                />
                <span className="mt-1 block text-xs text-slate-400">Facoltativo.</span>
              </label>
            ) : null}
          </div>
        ) : null}

        {/* Codice trasporto */}
        {showTransportCodeField ? (
          <>
            {tripLeg !== "return_only" ? (
            <label className={`text-sm ${contextLabels.transportCodeReturnLabel && tripLeg !== "outbound_only" ? "" : "md:col-span-2"}`}>
              {contextLabels.transportCodeLabel}
              <input className="input-saas mt-1" placeholder={contextLabels.transportCodePlaceholder} value={form.transport_code}
                onChange={(e) => setForm((prev) => ({ ...prev, transport_code: e.target.value }))}
              />
              {!isTransportCodeRequired ? <span className="mt-1 block text-xs text-slate-500">Campo facoltativo.</span> : null}
              {fieldErrors.transport_code ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.transport_code}</span> : null}
            </label>
            ) : null}
            {contextLabels.transportCodeReturnLabel && tripLeg !== "outbound_only" ? (
              <label className="text-sm">
                {contextLabels.transportCodeReturnLabel}
                <input className={`input-saas mt-1${fieldErrors.transport_code_return ? " border-rose-400" : ""}`} placeholder={contextLabels.transportCodeReturnPlaceholder ?? ""}
                  value={form.transport_code_return} onChange={(e) => { setForm((prev) => ({ ...prev, transport_code_return: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.transport_code_return; return n; }); }}
                />
                {fieldErrors.transport_code_return ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.transport_code_return}</span> : null}
              </label>
            ) : null}
          </>
        ) : null}

        {/* Bus catalog */}
        {isBusOriginRequired ? (
          <div className="text-sm md:col-span-2">
            <span className="font-medium text-slate-700">Città di partenza bus*</span>
            {busLoading ? <p className="mt-2 text-xs text-slate-500">Caricamento orari linee bus...</p> : (
              <div className="relative mt-1">
                <input className="input-saas" placeholder="Cerca città (es. Roma, Milano...)" value={busSearch} autoComplete="off"
                  onChange={(e) => { setBusSearch(e.target.value); setBusSearchOpen(true); if (!e.target.value.trim()) { setSelectedBusStop(null); setForm((prev) => ({ ...prev, bus_city_origin: "" })); } }}
                  onFocus={() => setBusSearchOpen(true)}
                  onBlur={() => setTimeout(() => setBusSearchOpen(false), 150)}
                />
                {busSearchOpen && busSearch.trim().length >= 2 ? (() => {
                  const q = busSearch.trim().toLowerCase();
                  const filtered = busStops.filter((s) => s.city.toLowerCase().includes(q)).slice(0, 10);
                  if (busCatalogError) {
                    return (
                      <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-rose-200 bg-white px-4 py-3 shadow-lg">
                        <p className="font-semibold text-rose-800">Catalogo linee bus non caricato</p>
                        <p className="mt-1 text-xs text-rose-600">{busCatalogError}</p>
                      </div>
                    );
                  }
                  if (!busCatalogLoaded || busStops.length === 0) {
                    return (
                      <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-amber-200 bg-white px-4 py-3 shadow-lg">
                        <p className="font-semibold text-amber-800">Catalogo linee bus non ancora disponibile</p>
                        <p className="mt-1 text-xs text-amber-600">Attendi il caricamento e riprova a scrivere la cittÃ .</p>
                      </div>
                    );
                  }
                  return filtered.length > 0 ? (
                    <ul className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                      {filtered.map((s) => (
                        <li key={`${s.lineCode}-${s.city}`} className="cursor-pointer border-b border-slate-100 px-3 py-2.5 last:border-b-0 hover:bg-slate-50"
                          onMouseDown={() => { setSelectedBusStop(s); setBusSearch(s.city); setBusSearchOpen(false); setForm((prev) => ({ ...prev, bus_city_origin: s.city, arrival_time: s.time, transport_code: s.lineName })); }}>
                          <span className="font-semibold text-slate-800">{s.city}</span>
                          <span className="ml-2 text-xs text-slate-500">{s.lineName} · {s.time}</span>
                          {s.pickupNote ? <span className="mt-0.5 block text-xs text-slate-400">{s.pickupNote}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-amber-200 bg-white px-4 py-3 shadow-lg">
                      <p className="font-semibold text-amber-800">Città non trovata nel catalogo</p>
                    </div>
                  );
                })() : null}
              </div>
            )}
            {selectedBusStop ? (
              <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <span className="font-semibold">{selectedBusStop.lineName}</span> · Orario pick-up andata: <span className="font-semibold">{selectedBusStop.time}</span>
                {selectedBusStop.pickupNote ? <span className="mt-0.5 block">📍 {selectedBusStop.pickupNote}</span> : null}
              </div>
            ) : null}
            {selectedBusStop && (busReturnTime || busReturnTimeLoading) ? (
              <div className="mt-1 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                {busReturnTimeLoading ? <span>Ricerca orario pick-up ritorno...</span> : busReturnTime ? <>Orario pick-up ritorno: <span className="font-semibold">{busReturnTime}</span> <span className="ml-1 text-blue-600">(compilato auto)</span></> : null}
              </div>
            ) : null}
            {fieldErrors.bus_city_origin ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.bus_city_origin}</span> : null}
          </div>
        ) : null}

        {/* Escursione */}
        {isExcursionTitleRequired ? (
          <label className="text-sm md:col-span-2">
            Escursione*
            {excursionLines.length > 0 ? (
              <select className="input-saas mt-1" value={form.excursion_title} onChange={(e) => setForm((prev) => ({ ...prev, excursion_title: e.target.value }))}>
                {excursionLines.map((ex) => <option key={ex.id} value={ex.name}>{ex.name}</option>)}
              </select>
            ) : (
              <input className="input-saas mt-1" placeholder="Nome escursione" value={form.excursion_title} onChange={(e) => setForm((prev) => ({ ...prev, excursion_title: e.target.value }))} />
            )}
            {fieldErrors.excursion_title ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.excursion_title}</span> : null}
          </label>
        ) : null}

        {/* Porto di partenza / prelevamento (solo escursioni) */}
        {isExcursionTitleRequired ? (
          <div className="md:col-span-2 grid grid-cols-2 gap-3">
            <label className="text-sm">
              Porto di partenza*
              <select
                className={`input-saas mt-1${fieldErrors.excursion_departure_port ? " border-rose-400" : ""}`}
                value={form.excursion_departure_port}
                onChange={(e) => { setForm((prev) => ({ ...prev, excursion_departure_port: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.excursion_departure_port; return n; }); }}
              >
                <option value="">— Seleziona porto —</option>
                {EXCURSION_PORTS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              {fieldErrors.excursion_departure_port ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.excursion_departure_port}</span> : null}
            </label>
            <label className="text-sm">
              Porto di prelevamento*
              <select
                className={`input-saas mt-1${fieldErrors.excursion_pickup_port ? " border-rose-400" : ""}`}
                value={form.excursion_pickup_port}
                onChange={(e) => { setForm((prev) => ({ ...prev, excursion_pickup_port: e.target.value })); setFieldErrors((prev) => { const n = { ...prev }; delete n.excursion_pickup_port; return n; }); }}
              >
                <option value="">— Seleziona porto —</option>
                {EXCURSION_PORTS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              {fieldErrors.excursion_pickup_port ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.excursion_pickup_port}</span> : null}
            </label>
          </div>
        ) : null}

        {/* Agenzia fatturazione */}
        <div className="text-sm md:col-span-2">
          <div className="flex items-center justify-between">
            <span>Agenzia fatturazione</span>
            <button type="button" onClick={() => setAddingAgency((v) => !v)} className="text-xs text-blue-600 hover:underline">
              {addingAgency ? "Annulla" : "+ Nuova agenzia"}
            </button>
          </div>
          {addingAgency ? (
            <div className="mt-2 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
              <input className="input-saas" placeholder="Nome agenzia*" value={newAgencyName} onChange={(e) => setNewAgencyName(e.target.value)} />
              <button type="button" onClick={() => void createAgency()} disabled={savingAgency || !newAgencyName.trim()} className="btn-primary w-full py-1.5 text-xs disabled:opacity-60">
                {savingAgency ? "Salvataggio..." : "Salva agenzia"}
              </button>
            </div>
          ) : (
            <select className="input-saas mt-1" value={form.agency_id} onChange={(e) => setForm((prev) => ({ ...prev, agency_id: e.target.value }))}>
              <option value="">— Nessuna agenzia —</option>
              {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <span className="mt-1 block text-xs text-slate-400">Opzionale — usata per fatturazione e statistiche.</span>
        </div>

        {/* Prezzo concordato */}
        <label className="text-sm">
          Prezzo concordato (€)
          <div className="mt-1 flex items-center gap-0 rounded-xl border border-slate-200 bg-white focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 transition-all min-h-[42px] overflow-hidden">
            <span className="px-3 text-slate-500 font-semibold text-sm shrink-0 select-none">€</span>
            <input type="text" inputMode="decimal" placeholder="0.00" className="flex-1 bg-transparent outline-none text-sm py-2 pr-3 min-w-0" data-no-uppercase
              value={form.quoted_price_eur}
              onChange={(e) => { const v = e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""); setForm((prev) => ({ ...prev, quoted_price_eur: v })); }}
            />
          </div>
          <span className="mt-1 block text-[11px] text-slate-400">Opzionale.</span>
        </label>

        {/* Note */}
        <label className="text-sm md:col-span-2">
          Note
          <textarea rows={4} className="input-saas mt-1 min-h-[104px]" value={form.notes}
            onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
          />
          {fieldErrors.notes ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.notes}</span> : null}
        </label>

        {/* Anteprima */}
        <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted md:col-span-2">
          <p className="font-semibold text-text">Anteprima prenotazione</p>
          <p className="mt-1">
            {isSnavKind ? (form.customer_last_name || "Nome completo") : `${form.customer_first_name || "Nome"} ${form.customer_last_name || "Cognome"}`}
            {" | "}{serviceKindLabel} | Pax {form.pax || "0"}
          </p>
          {Number(form.infant_count || "0") > 0 || Number(form.pet_count || "0") > 0 ? (
            <p>
              {Number(form.infant_count || "0") > 0 ? `Infant ${form.infant_count} (EUR 2,50 cad.)` : null}
              {Number(form.infant_count || "0") > 0 && Number(form.pet_count || "0") > 0 ? " | " : ""}
              {Number(form.pet_count || "0") > 0 ? `Animali ${form.pet_count} max 10 kg, biglietto cliente` : null}
            </p>
          ) : null}
          <p>{contextLabels.arrivalDateLabel.replace("*", "")} {form.arrival_date} {form.arrival_time} — {contextLabels.departureDateLabel.replace("*", "")} {form.departure_date} {form.departure_time}</p>
          {form.transport_code ? <p>{contextLabels.transportCodeLabel.replace("*", "")}: {form.transport_code}{form.transport_code_return ? ` / ritorno: ${form.transport_code_return}` : ""}</p> : null}
          {form.agency_id ? <p>Agenzia: {agencies.find((a) => a.id === form.agency_id)?.name ?? "—"}</p> : null}
          {form.notes.trim() ? <p className="line-clamp-2">Note: {form.notes.trim()}</p> : null}
        </div>

        {/* Warnings / OK */}
        {reviewWarnings.length > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 md:col-span-2">
            <p className="font-semibold">Controlli prima della conferma</p>
            {reviewWarnings.map((w) => <p key={w} className="mt-1">- {w}</p>)}
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 md:col-span-2">
            <p className="font-semibold">Pronto per la conferma</p>
            <p className="mt-1">I campi principali risultano compilati.</p>
          </div>
        )}

        {/* `message` e' riservato agli errori (rosso): il successo vive solo nella card verde in cima alla pagina. */}
        {message ? (
          <div className="md:col-span-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
            {message}
          </div>
        ) : null}

        </div>
      </div>

      <aside className="pms-panel top-5 p-5 xl:sticky">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-lg text-indigo-700">▣</span>
          <div>
            <p className="text-base font-bold text-slate-950">Riepilogo prenotazione</p>
            <p className="text-xs text-slate-500">Si aggiorna mentre compili</p>
          </div>
        </div>
        <div className="py-4">
          <p className="text-base font-extrabold text-slate-950">{isSnavKind ? form.customer_last_name || "Cliente" : `${form.customer_first_name || "Nome"} ${form.customer_last_name || "Cognome"}`}</p>
          <p className="mt-1 text-xs text-slate-500">{form.customer_phone || "Telefono non indicato"} · {form.pax || "0"} pax</p>
          <p className="mt-2 text-sm font-bold text-indigo-700">{form.agency_id ? agencies.find((agency) => agency.id === form.agency_id)?.name : "Privato"}</p>
          <p className="mt-1 text-xs font-medium text-slate-600">Hotel: {selectedHotel?.name ?? "Da selezionare"}</p>
        </div>
        {tripLeg !== "return_only" ? (
          <div className="border-t border-dashed border-slate-200 py-4">
            <p className="text-xs font-extrabold uppercase tracking-wide text-blue-700">Arrivo</p>
            <p className="mt-2 text-sm font-semibold text-slate-800">{form.arrival_date || "Data da indicare"}</p>
            <p className="mt-1 text-xs text-slate-600">{serviceKindLabel} · {form.arrival_time || "—"}</p>
            {portoArrivo ? <p className="mt-1 text-xs text-slate-600">Arrivo a {portoArrivo}</p> : null}
          </div>
        ) : null}
        {tripLeg !== "outbound_only" ? (
          <div className="border-t border-dashed border-slate-200 py-4">
            <p className="text-xs font-extrabold uppercase tracking-wide text-violet-700">Partenza</p>
            <p className="mt-2 text-sm font-semibold text-slate-800">{form.departure_date || "Data da indicare"}</p>
            {depRuleInfo?.pickup ? <p className="mt-1 text-xs text-slate-600">Pickup hotel {depRuleInfo.pickup}</p> : null}
            <p className="mt-1 text-xs text-slate-600">{serviceKindLabel} · {isSnavMedmar ? ferryDepTime : form.departure_time || "—"}</p>
          </div>
        ) : null}
        <div className={`mt-2 rounded-xl border p-3 text-xs ${reviewWarnings.length === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          <p className="font-bold">{reviewWarnings.length === 0 ? "Dati completi" : `${reviewWarnings.length} controlli da completare`}</p>
          <p className="mt-1">{reviewWarnings.length === 0 ? "La prenotazione è pronta per essere confermata." : reviewWarnings[0]}</p>
        </div>
      </aside>
      <div className="sticky bottom-0 z-20 col-span-full flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_-8px_30px_rgba(15,23,42,0.08)] backdrop-blur sm:flex-row sm:items-center">
        <Link href="/services" className="btn-secondary sm:mr-auto">Annulla</Link>
        <button type="button" onClick={() => void submit()} disabled={submitting || reviewWarnings.length > 0} className="btn-secondary disabled:opacity-60">
          Salva e creane un&apos;altra
        </button>
        <button type="button" onClick={() => void submit()} disabled={submitting || reviewWarnings.length > 0} className="btn-primary min-w-56 disabled:opacity-60">
          {submitting ? "Creazione in corso..." : "Conferma prenotazione"}
        </button>
      </div>
      </div>
      </>
      )}

      {/* Modal duplicato */}
      {duplicateWarning ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 p-4" onClick={() => setDuplicateWarning(null)}>
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center text-4xl">{duplicateWarning.match_type === "exact" ? "⚠️" : "🔎"}</div>
            <h2 className="text-center text-lg font-bold text-slate-800">
              {duplicateWarning.match_type === "exact" ? "Prenotazione già esistente" : "Possibile duplicato"}
            </h2>
            <p className="text-center text-sm text-slate-500">
              {duplicateWarning.match_type === "exact"
                ? "Esiste già una pratica attiva con stesso nome e telefono. Si tratta di una modifica?"
                : "Stesso nome ma telefono diverso — potrebbe essere una modifica di una pratica esistente?"}
            </p>
            {/* Card nuova prenotazione */}
            <div className="w-full rounded-xl border-2 border-indigo-300 bg-indigo-50 divide-y divide-indigo-100 text-sm">
              <div className="px-3 py-2 bg-indigo-600 rounded-t-xl">
                <span className="text-xs font-bold text-white uppercase tracking-wide">Nuova prenotazione</span>
              </div>
              {[
                ["Cliente", duplicateWarning.customer_name],
                ["Tipo", "Arrivo"],
                ...(form.arrival_date ? [["Arrivo", form.arrival_date.split("-").reverse().join("/")]] : []),
                ...(form.departure_date ? [["Partenza", form.departure_date.split("-").reverse().join("/")]] : []),
                ["Hotel", hotels.find((h) => h.id === form.hotel_id)?.name ?? "—"],
                ...(form.pax ? [["Pax", form.pax]] : []),
                ...(form.customer_phone ? [["Telefono", form.customer_phone]] : []),
                ...(form.agency_id ? [["Agenzia", agencies.find((a) => a.id === form.agency_id)?.name ?? "—"]] : []),
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between px-3 py-1.5">
                  <span className="font-semibold text-indigo-600">{label}</span>
                  <span className="text-right text-slate-800">{value}</span>
                </div>
              ))}
            </div>

            <div className="flex gap-3 flex-wrap">
              {duplicateWarning.services.map((svc) => (
                <div key={svc.id} className="flex-1 min-w-[220px] rounded-xl border border-slate-200 bg-slate-50 divide-y divide-slate-100 text-sm">
                  {[
                    ["Cliente", duplicateWarning.customer_name],
                    ["Tipo", svc.direction],
                    ...(svc.arrival_date ? [["Arrivo", svc.arrival_date]] : []),
                    ...(svc.departure_date ? [["Partenza", svc.departure_date]] : []),
                    ["Hotel", svc.hotel_name],
                    ...(svc.pax ? [["Pax", String(svc.pax)]] : []),
                    ...(svc.phone ? [["Telefono", svc.phone]] : []),
                    ...(svc.agency_name ? [["Agenzia", svc.agency_name]] : []),
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between px-3 py-1.5">
                      <span className="font-semibold text-slate-500">{label}</span>
                      <span className="text-right text-slate-800">{value}</span>
                    </div>
                  ))}
                  <div className="px-3 py-2">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={async () => {
                          if (!accessToken) return;
                          setSubmitting(true);
                          try {
                            const payload = {
                              ...normalizedPayload,
                              agency_id: normalizedPayload.agency_id || null,
                              agency_quoted_price_cents: normalizedPayload.agency_quoted_price_cents ?? null,
                            };
                            const res = await fetch(`/api/ops/services/${svc.id}/replace`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
                              body: JSON.stringify(payload),
                            });
                            const body = await res.json() as { ok?: boolean; error?: string };
                            if (!res.ok || !body.ok) {
                              setReplaceError(body.error ?? "Errore durante la sostituzione. Riprova.");
                            } else {
                              router.push("/inbox");
                            }
                          } finally {
                            setSubmitting(false);
                          }
                        }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-60"
                      >
                        {submitting ? "Sostituzione..." : "✏️ Sostituisci pratica esistente"}
                      </button>
                  </div>
                </div>
              ))}
            </div>
            {replaceError ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 font-medium">
                {replaceError}
              </div>
            ) : null}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => { setDuplicateWarning(null); setReplaceError(null); }}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button type="button" onClick={() => void submit(true)}
                className="flex-1 rounded-xl bg-slate-800 py-2.5 text-sm font-bold text-white hover:bg-slate-700">
                Inserisci comunque
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
