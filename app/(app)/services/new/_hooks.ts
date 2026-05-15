"use client";

import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import {
  buildFerryScheduleOptions,
  ferryPortLabel,
  type FerryScheduleRow,
} from "@/lib/ferry-schedule-options";
import { supabase } from "@/lib/supabase/client";
import { todayIsoDate } from "@/lib/utils";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { getDepartureRule, normalizeZonaToPickup } from "@/lib/snav-medmar-lookup";

export type BookingKind = z.infer<typeof agencyBookingCreateSchema>["booking_service_kind"];

export interface HotelOption {
  id: string;
  name: string;
  zone: string | null;
}

export interface BusCatalogStop {
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

export type FormState = {
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  pax: string;
  infant_count: string;
  pet_count: string;
  pet_notes: string;
  hotel_id: string;
  hotel_dest_id: string;
  booking_service_kind: BookingKind;
  arrival_date: string;
  arrival_time: string;
  departure_date: string;
  departure_time: string;
  transport_code: string;
  transport_code_return: string;
  bus_city_origin: string;
  excursion_title: string;
  excursion_departure_port: string;
  excursion_pickup_port: string;
  pickup_time_outbound: string;
  pickup_time_return: string;
  notes: string;
  agency_id: string;
  quoted_price_eur: string;
};

function initialForm(firstHotelId = ""): FormState {
  return {
    customer_first_name: "",
    customer_last_name: "",
    customer_phone: "",
    pax: "2",
    infant_count: "0",
    pet_count: "0",
    pet_notes: "",
    hotel_id: firstHotelId,
    hotel_dest_id: "",
    booking_service_kind: "transfer_port_hotel",
    arrival_date: todayIsoDate(),
    arrival_time: "12:00",
    departure_date: todayIsoDate(),
    departure_time: "18:00",
    transport_code: "",
    transport_code_return: "",
    bus_city_origin: "",
    excursion_title: "",
    excursion_departure_port: "",
    excursion_pickup_port: "",
    pickup_time_outbound: "",
    pickup_time_return: "",
    notes: "",
    agency_id: "",
    quoted_price_eur: "",
  };
}

export function useServiceForm(opts: {
  hotels: HotelOption[];
  ferryScheduleRows: FerryScheduleRow[];
  tenantId: string | null;
}) {
  const { hotels, ferryScheduleRows, tenantId } = opts;

  const [form, setForm] = useState<FormState>(() => initialForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tripLeg, setTripLeg] = useState<"outbound_only" | "return_only" | "round_trip">("outbound_only");
  const [ferryDepTime, setFerryDepTime] = useState<string>("07:10");
  const [excursionLines, setExcursionLines] = useState<Array<{ id: string; name: string }>>([]);

  // Auto-fill prelievo hotel per SNAV/MEDMAR
  useEffect(() => {
    const kind = form.booking_service_kind;
    if (kind !== "formula_snav" && kind !== "formula_medmar_napoli" && kind !== "formula_medmar_pozzuoli") return;
    const company = kind === "formula_snav" ? "snav" as const : "medmar" as const;
    const hotel = hotels.find((h) => h.id === form.hotel_id);
    const zona = normalizeZonaToPickup(hotel?.zone ?? null);
    const rule = getDepartureRule(company, ferryDepTime);
    const pickup = rule?.pickup_by_zona[zona] ?? null;
    if (pickup) setForm((prev) => ({ ...prev, departure_time: pickup }));
  }, [form.booking_service_kind, ferryDepTime, form.hotel_id, hotels]);

  // Reset ferry dep time quando cambia tipo servizio o data partenza
  useEffect(() => {
    const kind = form.booking_service_kind;
    if (kind === "formula_snav") {
      const available = buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "snav" }).map((o) => o.time);
      if (!available.includes(ferryDepTime)) setFerryDepTime(available[0] ?? "07:10");
    } else if (kind === "formula_medmar_napoli") {
      const available = buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "medmar", arrivalPort: "napoli_beverello" }).map((o) => o.time);
      if (!available.includes(ferryDepTime)) setFerryDepTime(available[0] ?? "06:25");
    } else if (kind === "formula_medmar_pozzuoli") {
      const available = buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "medmar", arrivalPort: "pozzuoli" }).map((o) => o.time);
      if (!available.includes(ferryDepTime)) setFerryDepTime(available[0] ?? "06:20");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.booking_service_kind, ferryScheduleRows, form.departure_date]);

  // Reset arrival_time SNAV/MEDMAR se non disponibile nella data selezionata
  useEffect(() => {
    const kind = form.booking_service_kind;
    if (kind !== "formula_snav" && kind !== "formula_medmar_napoli" && kind !== "formula_medmar_pozzuoli") return;
    const available = kind === "formula_snav"
      ? buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "snav" }).map((o) => o.time)
      : kind === "formula_medmar_napoli"
        ? buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "medmar", departurePort: "napoli_beverello" }).map((o) => o.time)
        : buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "medmar", departurePort: "pozzuoli" }).map((o) => o.time);
    if (!available.includes(form.arrival_time)) {
      setForm((prev) => ({ ...prev, arrival_time: available[0] ?? "" }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.booking_service_kind, ferryScheduleRows, form.arrival_date]);

  // Escursioni: carica linee al bisogno e pre-seleziona la prima
  useEffect(() => {
    if (form.booking_service_kind !== "excursion" || !supabase || !tenantId) return;
    if (excursionLines.length > 0) {
      setForm((prev) => prev.excursion_title ? prev : { ...prev, excursion_title: excursionLines[0]?.name ?? "" });
      return;
    }
    supabase.from("excursion_lines").select("id, name").eq("tenant_id", tenantId).eq("active", true).order("sort_order")
      .then(({ data }) => {
        if (data?.length) {
          setExcursionLines(data as Array<{ id: string; name: string }>);
          setForm((prev) => ({ ...prev, excursion_title: prev.excursion_title || data[0]?.name || "" }));
        }
      });
  }, [form.booking_service_kind, tenantId, excursionLines]);

  // Per private_island: departure_date = arrival_date (stesso giorno)
  useEffect(() => {
    if (form.booking_service_kind === "private_island") {
      setForm((prev) => prev.departure_date === prev.arrival_date ? prev : { ...prev, departure_date: prev.arrival_date });
    }
  }, [form.arrival_date, form.booking_service_kind]);

  const selectedKind = form.booking_service_kind;
  const isSnavKind    = selectedKind === "formula_snav";
  const isMedmarKind  = selectedKind === "formula_medmar_napoli" || selectedKind === "formula_medmar_pozzuoli";
  const isSnavMedmar  = isSnavKind || isMedmarKind;
  const snavMedmarCompany = isSnavKind ? "snav" : isMedmarKind ? "medmar" : null;
  const isPrivateIsland       = selectedKind === "private_island";
  const isTransferHotelHotel  = selectedKind === "transfer_hotel_hotel";
  const isBusOriginRequired   = selectedKind === "bus_city_hotel";
  const isExcursionTitleRequired = selectedKind === "excursion";
  const isTransportCodeRequired  = selectedKind === "transfer_airport_hotel" || selectedKind === "transfer_airport_hotel_aliscafo" || selectedKind === "transfer_train_hotel" || selectedKind === "transfer_train_hotel_aliscafo";
  const isPhoneRequired          = selectedKind !== "shuttle_hotel" && selectedKind !== "excursion";
  const showTransportCodeField   = ["transfer_airport_hotel", "transfer_airport_hotel_exclusive", "transfer_airport_hotel_aliscafo", "transfer_train_hotel", "transfer_train_hotel_exclusive", "transfer_train_hotel_aliscafo"].includes(selectedKind);
  const showTripLeg     = [
    "formula_snav",
    "formula_medmar_napoli",
    "formula_medmar_pozzuoli",
    "transfer_airport_hotel",
    "transfer_airport_hotel_exclusive",
    "transfer_airport_hotel_aliscafo",
    "transfer_train_hotel",
    "transfer_train_hotel_exclusive",
    "transfer_train_hotel_aliscafo",
    "transfer_port_hotel",
    "transfer_hotel_hotel",
    "shuttle_hotel",
  ].includes(selectedKind);
  const isRoundTrip     = tripLeg === "round_trip" && showTripLeg;
  const showPickupTime  = !isSnavMedmar && !isBusOriginRequired && !isPrivateIsland;

  const snavArrivalOptions = useMemo(
    () => buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "snav" }),
    [form.arrival_date, ferryScheduleRows]
  );
  const snavDepartureOptions = useMemo(
    () => buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "snav" }),
    [form.departure_date, ferryScheduleRows]
  );
  const medmarArrivalOptions = useMemo(
    () => buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "medmar", departurePort: selectedKind === "formula_medmar_napoli" ? "napoli_beverello" : "pozzuoli" }),
    [form.arrival_date, ferryScheduleRows, selectedKind]
  );
  const medmarDepartureOptions = useMemo(
    () => buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "medmar", arrivalPort: selectedKind === "formula_medmar_napoli" ? "napoli_beverello" : "pozzuoli" }),
    [form.departure_date, ferryScheduleRows, selectedKind]
  );

  const hotelZona = useMemo(() => {
    const h = hotels.find((h) => h.id === form.hotel_id);
    return normalizeZonaToPickup(h?.zone ?? null);
  }, [hotels, form.hotel_id]);

  const portoArrivo = useMemo(() => {
    if (!snavMedmarCompany) return null;
    const options = isSnavKind ? snavArrivalOptions : isMedmarKind ? medmarArrivalOptions : [];
    const porto = options.find((o) => o.time === form.arrival_time)?.porto ?? null;
    return porto ? ferryPortLabel(porto) : null;
  }, [form.arrival_time, isMedmarKind, isSnavKind, medmarArrivalOptions, snavMedmarCompany, snavArrivalOptions]);

  const depRuleInfo = useMemo(() => {
    if (!snavMedmarCompany) return null;
    const options = isSnavKind ? snavDepartureOptions : isMedmarKind ? medmarDepartureOptions : [];
    const rule = getDepartureRule(snavMedmarCompany, ferryDepTime);
    if (!rule) return null;
    const porto = options.find((o) => o.time === ferryDepTime)?.porto ?? rule.porto_ischia;
    return { porto: ferryPortLabel(porto), pickup: rule.pickup_by_zona[hotelZona] ?? null };
  }, [ferryDepTime, hotelZona, isMedmarKind, isSnavKind, medmarDepartureOptions, snavDepartureOptions, snavMedmarCompany]);

  const normalizedPayload = useMemo(() => ({
    ...form,
    pax: Number(form.pax || "0"),
    infant_count: Number(form.infant_count || "0"),
    pet_count: Number(form.pet_count || "0"),
    pet_notes: form.pet_notes.trim(),
    notes: form.notes.trim(),
    transport_code_return: form.transport_code_return.trim(),
    agency_quoted_price_cents: form.quoted_price_eur
      ? Math.round(Number(form.quoted_price_eur.replace(",", ".")) * 100)
      : null,
    trip_leg: showTripLeg ? tripLeg : undefined,
  }), [form, showTripLeg, tripLeg]);

  const parsedPreview = useMemo(() => agencyBookingCreateSchema.safeParse(normalizedPayload), [normalizedPayload]);
  const isFormValid = parsedPreview.success && hotels.length > 0;

  const serviceKindLabel = selectedKind === "formula_snav" ? "Formula SNAV"
    : selectedKind === "formula_medmar_napoli" ? "Formula MEDMAR — Napoli"
    : selectedKind === "formula_medmar_pozzuoli" ? "Formula MEDMAR — Pozzuoli"
    : selectedKind;

  const reviewWarnings = useMemo(() => {
    const w: string[] = [];
    if (isSnavKind) {
      if (!form.customer_last_name.trim()) w.push("Inserisci il nome completo del cliente.");
    } else {
      if (!form.customer_first_name.trim() || !form.customer_last_name.trim()) w.push("Completa nome e cognome cliente.");
    }
    if (isPhoneRequired && !form.customer_phone.trim()) w.push("Inserisci un telefono cliente.");
    const paxNum = Number(form.pax);
    if (!form.pax || isNaN(paxNum) || paxNum < 1) w.push("Inserisci il numero di pax (min. 1).");
    if (Number(form.pet_count || "0") > 0 && !form.pet_notes.trim()) w.push("Indica tipo/taglia animale nelle note animali.");
    if (!form.hotel_id && !isPrivateIsland) w.push("Seleziona la struttura.");
    if (!(showTripLeg && tripLeg === "return_only") && !form.arrival_date) w.push("Data arrivo mancante.");
    if (!(showTripLeg && tripLeg === "return_only") && !form.arrival_time) w.push("Ora arrivo mancante.");
    if (!(showTripLeg && tripLeg === "outbound_only") && !form.departure_date) w.push("Data partenza mancante.");
    if (!(showTripLeg && tripLeg === "outbound_only") && !form.departure_time) w.push("Ora partenza mancante.");
    if (isTransportCodeRequired && tripLeg !== "return_only" && !form.transport_code.trim()) w.push("Numero mezzo andata mancante.");
    if (isTransportCodeRequired && tripLeg !== "outbound_only" && !form.transport_code_return.trim()) w.push("Numero mezzo ritorno mancante.");
    if (isBusOriginRequired && !form.bus_city_origin.trim()) w.push("Città di partenza bus mancante.");
    if (isExcursionTitleRequired && !form.excursion_title.trim()) w.push("Nome escursione mancante.");
    if (isExcursionTitleRequired && !form.excursion_departure_port) w.push("Seleziona il porto di partenza.");
    if (isExcursionTitleRequired && !form.excursion_pickup_port) w.push("Seleziona il porto di prelevamento.");
    return w;
  }, [form, isSnavKind, isPhoneRequired, isPrivateIsland, isTransportCodeRequired, isBusOriginRequired, isExcursionTitleRequired, showTripLeg, tripLeg]);

  const resetForm = useCallback((firstHotelId = "") => {
    setForm(initialForm(firstHotelId));
    setFieldErrors({});
    setTripLeg("outbound_only");
  }, []);

  return {
    // raw state (needed by JSX setters)
    form, setForm, fieldErrors, setFieldErrors,
    tripLeg, setTripLeg,
    ferryDepTime, setFerryDepTime,
    excursionLines,
    // derived flags
    isSnavKind, isMedmarKind, isSnavMedmar, snavMedmarCompany,
    isPrivateIsland, isTransferHotelHotel, isBusOriginRequired,
    isExcursionTitleRequired, isTransportCodeRequired,
    isPhoneRequired, showTransportCodeField,
    showTripLeg, isRoundTrip, showPickupTime,
    // ferry options
    snavArrivalOptions, snavDepartureOptions,
    medmarArrivalOptions, medmarDepartureOptions,
    portoArrivo, depRuleInfo, hotelZona,
    // form metadata
    serviceKindLabel, normalizedPayload, parsedPreview,
    isFormValid, reviewWarnings,
    // actions
    resetForm,
  };
}

export function useBusCatalog(opts: {
  bookingKind: BookingKind;
  hotelId: string;
  accessToken: string | null;
  onDepartureTimeChange: (t: string) => void;
}) {
  const { bookingKind, hotelId, accessToken, onDepartureTimeChange } = opts;

  const [busStops, setBusStops] = useState<BusCatalogStop[]>([]);
  const [busSearch, setBusSearch] = useState("");
  const [busSearchOpen, setBusSearchOpen] = useState(false);
  const [busLoading, setBusLoading] = useState(false);
  const [selectedBusStop, setSelectedBusStop] = useState<BusCatalogStop | null>(null);
  const [busReturnTime, setBusReturnTime] = useState<string | null>(null);
  const [busReturnTimeLoading, setBusReturnTimeLoading] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  // Load catalog when kind switches to bus_city_hotel
  useEffect(() => {
    if (bookingKind !== "bus_city_hotel" || !accessToken || busStops.length > 0) return;
    startTransition(() => setBusLoading(true));
    fetch("/api/agency/bus-catalog", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((r) => r.json())
      .then((body: { stops?: BusCatalogStop[] }) => { setBusStops(body.stops ?? []); })
      .catch(() => {})
      .finally(() => setBusLoading(false));
  }, [bookingKind, accessToken, busStops.length]);

  // Fetch return pickup time when stop + hotel change
  useEffect(() => {
    if (bookingKind !== "bus_city_hotel" || !selectedBusStop || !hotelId || !accessToken) {
      startTransition(() => setBusReturnTime(null));
      return;
    }
    const lineFamily = deriveBusLineFamily(selectedBusStop.lineCode);
    startTransition(() => setBusReturnTimeLoading(true));
    fetch(`/api/agency/bus-return-time?hotel_id=${encodeURIComponent(hotelId)}&line_family=${lineFamily}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((body: { pickup_time?: string | null }) => {
        const t = body.pickup_time ?? null;
        setBusReturnTime(t);
        if (t) onDepartureTimeChange(t);
      })
      .catch(() => { setBusReturnTime(null); })
      .finally(() => setBusReturnTimeLoading(false));
  }, [selectedBusStop, hotelId, bookingKind, accessToken, onDepartureTimeChange]);

  const reset = useCallback(() => {
    setBusSearch("");
    setSelectedBusStop(null);
    setBusReturnTime(null);
    setReplaceError(null);
  }, []);

  return {
    busStops, busSearch, setBusSearch,
    busSearchOpen, setBusSearchOpen,
    busLoading, selectedBusStop, setSelectedBusStop,
    busReturnTime, busReturnTimeLoading,
    replaceError, setReplaceError,
    reset,
  };
}
