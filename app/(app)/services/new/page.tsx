"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { DateInput } from "@/components/ui";
import {
  buildFerryScheduleOptions,
  type FerryScheduleRow,
  ferryPortLabel,
} from "@/lib/ferry-schedule-options";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { agencyBookingCreateSchema } from "@/lib/validation";
import {
  getDepartureRule, normalizeZonaToPickup,
} from "@/lib/snav-medmar-lookup";

type BookingKind = z.infer<typeof agencyBookingCreateSchema>["booking_service_kind"];
type OpsRole = "admin" | "operator";

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

// Orari traghetti: ora derivati da snav-medmar-lookup.ts

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

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
  const [message, setMessage] = useState("Compila i campi obbligatori e conferma la prenotazione.");
  const [submitting, setSubmitting] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [role, setRole] = useState<OpsRole | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [hotels, setHotels] = useState<HotelOption[]>([]);
  const [agencies, setAgencies] = useState<AgencyOption[]>([]);
  const [tripLeg, setTripLeg] = useState<"outbound_only" | "return_only" | "round_trip">("outbound_only");
  const [form, setForm] = useState({
    customer_first_name: "",
    customer_last_name: "",
    customer_phone: "",
    pax: "2",
    hotel_id: "",
    hotel_dest_id: "",
    booking_service_kind: "transfer_port_hotel" as BookingKind,
    arrival_date: todayIsoDate(),
    arrival_time: "12:00",
    departure_date: todayIsoDate(),
    departure_time: "18:00",
    transport_code: "",
    transport_code_return: "",
    bus_city_origin: "",
    excursion_title: "",
    pickup_time_outbound: "",
    pickup_time_return: "",
    notes: "",
    agency_id: "",
    quoted_price_eur: ""
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // SNAV/MEDMAR: orario traghetto partenza (UI only — departure_time = prelievo hotel auto-calcolato)
  const [ferryDepTime, setFerryDepTime] = useState<string>("07:10");
  const [ferryScheduleRows, setFerryScheduleRows] = useState<FerryScheduleRow[]>([]);

  // Hotel inline creation
  const [addingHotel, setAddingHotel] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [newHotelAddress, setNewHotelAddress] = useState("");
  const [newHotelCity, setNewHotelCity] = useState("");
  const [savingHotel, setSavingHotel] = useState(false);

  // Agency inline creation
  const [addingAgency, setAddingAgency] = useState(false);
  const [newAgencyName, setNewAgencyName] = useState("");
  const [savingAgency, setSavingAgency] = useState(false);

  // Duplicate detection modal
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

  // Bus catalog
  const [busStops, setBusStops] = useState<BusCatalogStop[]>([]);
  const [busSearch, setBusSearch] = useState("");
  const [busSearchOpen, setBusSearchOpen] = useState(false);
  const [busLoading, setBusLoading] = useState(false);
  const [selectedBusStop, setSelectedBusStop] = useState<BusCatalogStop | null>(null);
  const [busReturnTime, setBusReturnTime] = useState<string | null>(null);
  const [busReturnTimeLoading, setBusReturnTimeLoading] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  // Excursion lines
  const [excursionLines, setExcursionLines] = useState<Array<{ id: string; name: string }>>([]);

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
      if (session.role !== "admin" && session.role !== "operator") {
        setMessage("Ruolo non autorizzato per questa sezione.");
        setLoading(false);
        return;
      }

      setRole(session.role as OpsRole);
      setTenantId(session.tenantId);
      const { data: tokenData } = await supabase.auth.getSession();
      setAccessToken(tokenData.session?.access_token ?? null);

      const [hotelRes, agencyRes, snavScheduleRes] = await Promise.all([
        supabase.from("hotels").select("id, name, zone").eq("tenant_id", session.tenantId).order("name").limit(2000),
        supabase.from("agencies").select("id, name").eq("tenant_id", session.tenantId).eq("active", true).order("name"),
        supabase
          .from("ferry_schedules")
          .select("company, departure_port, arrival_port, departure_time, direction, days_of_week, valid_from, valid_to")
          .in("company", ["snav", "medmar"])
      ]);

      if (!active) return;
      if (hotelRes.error) { setMessage("Errore caricamento hotel."); setLoading(false); return; }

      const hotelRows = (hotelRes.data ?? []) as HotelOption[];
      setHotels(hotelRows);
      if (hotelRows[0]?.id) setForm((prev) => ({ ...prev, hotel_id: prev.hotel_id || hotelRows[0]!.id }));

      const agencyRows = (agencyRes.data ?? []) as AgencyOption[];
      setAgencies(agencyRows);
      setFerryScheduleRows((snavScheduleRes.data ?? []) as FerryScheduleRow[]);

      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, []);

  // Auto-fill prelievo hotel per SNAV/MEDMAR (calcolato inline per evitare forward-reference)
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

  // Reset ferry dep time quando cambia il tipo servizio o la data di partenza
  useEffect(() => {
    const kind = form.booking_service_kind;
    if (kind === "formula_snav") {
      const available = buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "snav" }).map((option) => option.time);
      if (!available.includes(ferryDepTime)) setFerryDepTime(available[0] ?? "07:10");
    } else if (kind === "formula_medmar_napoli") {
      const available = buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "medmar", arrivalPort: "napoli_beverello" }).map((option) => option.time);
      if (!available.includes(ferryDepTime)) setFerryDepTime(available[0] ?? "06:25");
    } else if (kind === "formula_medmar_pozzuoli") {
      const available = buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "medmar", arrivalPort: "pozzuoli" }).map((option) => option.time);
      if (!available.includes(ferryDepTime)) setFerryDepTime(available[0] ?? "06:20");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.booking_service_kind, ferryScheduleRows, form.departure_date]);

  // Reset arrival_time SNAV se non disponibile nella data selezionata
  useEffect(() => {
    const kind = form.booking_service_kind;
    if (kind !== "formula_snav" && kind !== "formula_medmar_napoli" && kind !== "formula_medmar_pozzuoli") return;
    const available = kind === "formula_snav"
      ? buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "snav" }).map((option) => option.time)
      : kind === "formula_medmar_napoli"
        ? buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "medmar", departurePort: "napoli_beverello" }).map((option) => option.time)
        : buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "medmar", departurePort: "pozzuoli" }).map((option) => option.time);
    if (!available.includes(form.arrival_time)) {
      setForm((prev) => ({ ...prev, arrival_time: available[0] ?? "" }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.booking_service_kind, ferryScheduleRows, form.arrival_date]);

  // Escursioni
  useEffect(() => {
    if (form.booking_service_kind !== "excursion" || !supabase || !tenantId || excursionLines.length > 0) return;
    supabase.from("excursion_lines").select("id, name").eq("tenant_id", tenantId).eq("active", true).order("sort_order")
      .then(({ data }) => {
        if (data?.length) {
          setExcursionLines(data as Array<{ id: string; name: string }>);
          setForm((prev) => ({ ...prev, excursion_title: prev.excursion_title || data[0]?.name || "" }));
        }
      });
  }, [form.booking_service_kind, tenantId, excursionLines.length]);

  // Bus catalog
  useEffect(() => {
    if (form.booking_service_kind !== "bus_city_hotel" || !accessToken || busStops.length > 0) return;
    setBusLoading(true);
    fetch("/api/agency/bus-catalog", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((r) => r.json())
      .then((body: { stops?: BusCatalogStop[] }) => { setBusStops(body.stops ?? []); })
      .catch(() => {})
      .finally(() => setBusLoading(false));
  }, [form.booking_service_kind, accessToken, busStops.length]);

  // Per private_island: departure_date = arrival_date (stesso giorno)
  useEffect(() => {
    if (form.booking_service_kind === "private_island") {
      setForm((prev) => prev.departure_date === prev.arrival_date ? prev : { ...prev, departure_date: prev.arrival_date });
    }
  }, [form.arrival_date, form.booking_service_kind]);

  // Bus return pickup
  useEffect(() => {
    if (form.booking_service_kind !== "bus_city_hotel" || !selectedBusStop || !form.hotel_id || !accessToken) {
      setBusReturnTime(null);
      return;
    }
    const lineFamily = deriveBusLineFamily(selectedBusStop.lineCode);
    setBusReturnTimeLoading(true);
    fetch(`/api/agency/bus-return-time?hotel_id=${encodeURIComponent(form.hotel_id)}&line_family=${lineFamily}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
      .then((r) => r.json())
      .then((body: { pickup_time?: string | null }) => {
        const t = body.pickup_time ?? null;
        setBusReturnTime(t);
        if (t) setForm((prev) => ({ ...prev, departure_time: t }));
      })
      .catch(() => { setBusReturnTime(null); })
      .finally(() => setBusReturnTimeLoading(false));
  }, [selectedBusStop, form.hotel_id, form.booking_service_kind, accessToken]);

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

  const selectedKind = form.booking_service_kind;
  const isSnavKind = selectedKind === "formula_snav";
  const isMedmarKind = selectedKind === "formula_medmar_napoli" || selectedKind === "formula_medmar_pozzuoli";
  const isSnavMedmar = isSnavKind || isMedmarKind;
  const snavMedmarCompany = isSnavKind ? "snav" : isMedmarKind ? "medmar" : null;
  const snavArrivalOptions = useMemo(
    () => buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", form.arrival_date, { company: "snav" }),
    [form.arrival_date, ferryScheduleRows]
  );
  const snavDepartureOptions = useMemo(
    () => buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", form.departure_date, { company: "snav" }),
    [form.departure_date, ferryScheduleRows]
  );
  const medmarArrivalOptions = useMemo(
    () => buildFerryScheduleOptions(
      ferryScheduleRows,
      "mainland_to_ischia",
      form.arrival_date,
      {
        company: "medmar",
        departurePort: selectedKind === "formula_medmar_napoli" ? "napoli_beverello" : "pozzuoli",
      }
    ),
    [form.arrival_date, ferryScheduleRows, selectedKind]
  );
  const medmarDepartureOptions = useMemo(
    () => buildFerryScheduleOptions(
      ferryScheduleRows,
      "ischia_to_mainland",
      form.departure_date,
      {
        company: "medmar",
        arrivalPort: selectedKind === "formula_medmar_napoli" ? "napoli_beverello" : "pozzuoli",
      }
    ),
    [form.departure_date, ferryScheduleRows, selectedKind]
  );
  // Porto arrivo (da orario traghetto arrivo)
  const portoArrivo = useMemo(() => {
    if (!snavMedmarCompany) return null;
    const activeArrivalOptions = isSnavKind ? snavArrivalOptions : isMedmarKind ? medmarArrivalOptions : [];
    const porto = activeArrivalOptions.find((option) => option.time === form.arrival_time)?.porto ?? null;
    return porto ? ferryPortLabel(porto) : null;
  }, [
    form.arrival_time,
    isMedmarKind,
    isSnavKind,
    medmarArrivalOptions,
    snavMedmarCompany,
    snavArrivalOptions,
  ]);

  // Porto e prelievo partenza (da orario traghetto partenza + zona hotel)
  const hotelZona = useMemo(() => {
    const h = hotels.find((h) => h.id === form.hotel_id);
    return normalizeZonaToPickup(h?.zone ?? null);
  }, [hotels, form.hotel_id]);

  const depRuleInfo = useMemo(() => {
    if (!snavMedmarCompany) return null;
    const activeDepartureOptions = isSnavKind ? snavDepartureOptions : isMedmarKind ? medmarDepartureOptions : [];
    const rule = getDepartureRule(snavMedmarCompany, ferryDepTime);
    if (!rule) return null;
    const porto = activeDepartureOptions.find((option) => option.time === ferryDepTime)?.porto ?? rule.porto_ischia;
    return {
      porto: ferryPortLabel(porto),
      pickup: rule.pickup_by_zona[hotelZona] ?? null,
    };
  }, [
    ferryDepTime,
    hotelZona,
    isMedmarKind,
    isSnavKind,
    medmarDepartureOptions,
    snavDepartureOptions,
    snavMedmarCompany,
  ]);

  const isTransportCodeRequired = selectedKind === "transfer_airport_hotel" || selectedKind === "transfer_airport_hotel_aliscafo" || selectedKind === "transfer_train_hotel" || selectedKind === "transfer_train_hotel_aliscafo";
  const isPhoneRequired = selectedKind !== "shuttle_hotel";
  const showTransportCodeField =
    selectedKind === "transfer_airport_hotel" ||
    selectedKind === "transfer_airport_hotel_exclusive" ||
    selectedKind === "transfer_airport_hotel_aliscafo" ||
    selectedKind === "transfer_train_hotel" ||
    selectedKind === "transfer_train_hotel_exclusive" ||
    selectedKind === "transfer_train_hotel_aliscafo";
  const isBusOriginRequired = selectedKind === "bus_city_hotel";
  const isExcursionTitleRequired = selectedKind === "excursion";
  const isPrivateIsland = selectedKind === "private_island";
  const isTransferHotelHotel = selectedKind === "transfer_hotel_hotel";
  const showTripLeg = ["transfer_port_hotel", "transfer_hotel_hotel", "excursion", "shuttle_hotel"].includes(selectedKind);
  const isRoundTrip = tripLeg === "round_trip" && showTripLeg;
  const showPickupTime = !isSnavMedmar && !isBusOriginRequired && !isPrivateIsland;
  const hasHotels = hotels.length > 0;

  const normalizedPayload = useMemo(() => ({
    ...form,
    pax: Number(form.pax || "0"),
    notes: form.notes.trim(),
    transport_code_return: form.transport_code_return.trim(),
    agency_quoted_price_cents: form.quoted_price_eur
      ? Math.round(Number(form.quoted_price_eur.replace(",", ".")) * 100)
      : null,
    trip_leg: showTripLeg ? tripLeg : undefined,
  }), [form, showTripLeg, tripLeg]);

  const parsedPreview = useMemo(() => agencyBookingCreateSchema.safeParse(normalizedPayload), [normalizedPayload]);
  const isFormValid = parsedPreview.success && hasHotels;

  const serviceKindLabel = useMemo(() => kindOptions.find((item) => item.value === selectedKind)?.label ?? "Servizio", [selectedKind]);
  const contextLabels = useMemo(() => bookingContext(selectedKind), [selectedKind]);

  const reviewWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (isSnavKind) {
      if (!form.customer_last_name.trim()) warnings.push("Inserisci il nome completo del cliente.");
    } else {
      if (!form.customer_first_name.trim() || !form.customer_last_name.trim()) warnings.push("Completa nome e cognome cliente.");
    }
    if (isPhoneRequired && !form.customer_phone.trim()) warnings.push("Inserisci un telefono cliente.");
    const paxNum = Number(form.pax);
    if (!form.pax || isNaN(paxNum) || paxNum < 1) warnings.push("Inserisci il numero di pax (min. 1).");
    if (!form.hotel_id && !isPrivateIsland) warnings.push("Seleziona la struttura.");
    if (!form.arrival_date) warnings.push(`${contextLabels.arrivalDateLabel.replace("*", "").trim()} mancante.`);
    if (!form.arrival_time) warnings.push(`${contextLabels.arrivalTimeLabel.replace("*", "").trim()} mancante.`);
    if (!form.departure_date) warnings.push(`${contextLabels.departureDateLabel.replace("*", "").trim()} mancante.`);
    if (!form.departure_time) warnings.push(`${contextLabels.departureTimeLabel.replace("*", "").trim()} mancante.`);
    if (isTransportCodeRequired && !form.transport_code.trim()) warnings.push(`${contextLabels.transportCodeLabel.replace("*", "")} mancante.`);
    if (isTransportCodeRequired && contextLabels.transportCodeReturnLabel && !form.transport_code_return.trim()) warnings.push(`${contextLabels.transportCodeReturnLabel.replace("*", "")} mancante.`);
    if (isBusOriginRequired && !form.bus_city_origin.trim()) warnings.push("Città di partenza bus mancante.");
    if (isExcursionTitleRequired && !form.excursion_title.trim()) warnings.push("Nome escursione mancante.");
    return warnings;
  }, [contextLabels.arrivalDateLabel, contextLabels.arrivalTimeLabel, contextLabels.departureDateLabel, contextLabels.departureTimeLabel, contextLabels.transportCodeLabel, contextLabels.transportCodeReturnLabel, form.arrival_date, form.arrival_time, form.bus_city_origin, form.customer_first_name, form.customer_last_name, form.customer_phone, form.departure_date, form.departure_time, form.excursion_title, form.hotel_id, form.pax, form.transport_code, form.transport_code_return, isBusOriginRequired, isExcursionTitleRequired, isPhoneRequired, isPrivateIsland, isSnavKind, isTransportCodeRequired]);

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

    // Per SNAV/MEDMAR passa porto arrivo come meeting_point e ferry_dep_time
    const extraFields = isSnavMedmar ? {
      meeting_point: portoArrivo ?? undefined,
      ferry_dep_time: ferryDepTime,
      porto_partenza: depRuleInfo?.porto ?? undefined,
    } : {};

    const response = await fetch("/api/ops/new-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...parsed.data, ...extraFields })
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; id?: string; id_return?: string; round_trip?: boolean; error?: string } | null;
    setSubmitting(false);

    if (!response.ok || !body?.id) {
      setMessage(body?.error ?? "Creazione prenotazione non riuscita.");
      return;
    }

    setMessage(body.round_trip
      ? `Prenotazione A/R creata (${serviceKindLabel}). Andata: ${body.id} · Ritorno: ${body.id_return ?? "—"}`
      : `Prenotazione creata (${serviceKindLabel}). ID: ${body.id}`);

    // Reset form
    const firstHotelId = hotels[0]?.id ?? "";
    setTripLeg("outbound_only");
    setForm({
      customer_first_name: "", customer_last_name: "", customer_phone: "",
      pax: "2", hotel_id: firstHotelId, hotel_dest_id: "",
      booking_service_kind: "transfer_port_hotel",
      arrival_date: todayIsoDate(), arrival_time: "12:00",
      departure_date: todayIsoDate(), departure_time: "18:00",
      transport_code: "", transport_code_return: "",
      bus_city_origin: "", excursion_title: "",
      pickup_time_outbound: "", pickup_time_return: "",
      notes: "", agency_id: "", quoted_price_eur: ""
    });
    setFieldErrors({});
    setBusSearch(""); setSelectedBusStop(null); setBusReturnTime(null);
  };

  const submit = async (force = false) => {
    // Blocco duro: evidenzia campi obbligatori mancanti
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
      if (!form.hotel_id && !isPrivateIsland) errs.hotel_id = "Seleziona la struttura";
      if (!form.arrival_date) errs.arrival_date = "Campo obbligatorio";
      if (!form.arrival_time) errs.arrival_time = "Campo obbligatorio";
      if (!form.departure_date) errs.departure_date = "Campo obbligatorio";
      if (!form.departure_time) errs.departure_time = "Campo obbligatorio";
      if (isTransportCodeRequired && !form.transport_code.trim()) errs.transport_code = "Campo obbligatorio";
      if (isTransportCodeRequired && contextLabels.transportCodeReturnLabel && !form.transport_code_return.trim()) errs.transport_code_return = "Campo obbligatorio";
      if (isBusOriginRequired && !form.bus_city_origin.trim()) errs.bus_city_origin = "Campo obbligatorio";
      if (isExcursionTitleRequired && !form.excursion_title.trim()) errs.excursion_title = "Campo obbligatorio";
      setFieldErrors(errs);
      setMessage("Compila tutti i campi obbligatori (*) prima di continuare.");
      return;
    }

    const parsed = agencyBookingCreateSchema.safeParse(normalizedPayload);
    if (!parsed.success) { await doSubmit(); return; }

    // Check duplicati
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
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento...</div>;
  if (!hasSupabaseEnv || !supabase) return <div className="card p-4 text-sm text-slate-500">Supabase non configurato.</div>;

  return (
    <section className="mx-auto max-w-5xl page-section">
      <div className="section-head">
        <h1 className="section-title">Nuova prenotazione</h1>
        <p className="section-subtitle">Inserimento diretto da {role === "admin" ? "amministratore" : "operatore"}.</p>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <Link href="/services" className="btn-secondary px-3 py-1.5 text-xs">← Lista servizi</Link>
      </div>

      {!hasHotels ? (
        <article className="card space-y-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 mb-4">
          <p className="font-semibold">Nessun hotel disponibile.</p>
          <Link href="/hotels" className="btn-secondary px-3 py-1.5 text-xs">Apri hotel</Link>
        </article>
      ) : null}

      <div className="card grid gap-3 p-4 md:grid-cols-2 md:p-5">

        {/* Tipo servizio */}
        <label className="text-sm md:col-span-2">
          Tipo servizio*
          <select
            className="input-saas mt-1"
            value={form.booking_service_kind}
            onChange={(e) => {
              const kind = e.target.value as BookingKind;
              setForm((prev) => ({
                ...prev,
                booking_service_kind: kind,
                arrival_date: kind === "bus_city_hotel" ? nextSunday(prev.arrival_date) : prev.arrival_date,
                departure_date: kind === "bus_city_hotel" ? nextSunday(prev.departure_date, true) : prev.departure_date,
                arrival_time: kind === "formula_snav" ? (snavArrivalOptions[0]?.time ?? prev.arrival_time) : kind === "formula_medmar_napoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", prev.arrival_date, { company: "medmar", departurePort: "napoli_beverello" })[0]?.time ?? prev.arrival_time) : kind === "formula_medmar_pozzuoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "mainland_to_ischia", prev.arrival_date, { company: "medmar", departurePort: "pozzuoli" })[0]?.time ?? prev.arrival_time) : prev.arrival_time,
                departure_time: kind === "formula_snav" ? (snavDepartureOptions[0]?.time ?? prev.departure_time) : kind === "formula_medmar_napoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", prev.departure_date, { company: "medmar", arrivalPort: "napoli_beverello" })[0]?.time ?? prev.departure_time) : kind === "formula_medmar_pozzuoli" ? (buildFerryScheduleOptions(ferryScheduleRows, "ischia_to_mainland", prev.departure_date, { company: "medmar", arrivalPort: "pozzuoli" })[0]?.time ?? prev.departure_time) : prev.departure_time
              }));
              if (kind !== "bus_city_hotel") { setBusSearch(""); setSelectedBusStop(null); }
            }}
          >
            {kindOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>

        {/* Nome cliente */}
        {isSnavKind ? (
          <label className="text-sm md:col-span-2">
            Nome completo cliente*
            <input className="input-saas mt-1" placeholder="Es. Mario Rossi"
              value={form.customer_last_name}
              onChange={(e) => setForm((prev) => ({ ...prev, customer_last_name: e.target.value, customer_first_name: "" }))}
            />
            {fieldErrors.customer_last_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_last_name}</span> : null}
          </label>
        ) : (
          <>
            <label className="text-sm">
              Nome*
              <input className="input-saas mt-1" value={form.customer_first_name}
                onChange={(e) => setForm((prev) => ({ ...prev, customer_first_name: e.target.value }))}
              />
              {fieldErrors.customer_first_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_first_name}</span> : null}
            </label>
            <label className="text-sm">
              Cognome*
              <input className="input-saas mt-1" value={form.customer_last_name}
                onChange={(e) => setForm((prev) => ({ ...prev, customer_last_name: e.target.value }))}
              />
              {fieldErrors.customer_last_name ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_last_name}</span> : null}
            </label>
          </>
        )}

        <label className="text-sm">
          {isPhoneRequired ? "Telefono*" : "Telefono"}
          <input className="input-saas mt-1" value={form.customer_phone}
            onChange={(e) => setForm((prev) => ({ ...prev, customer_phone: e.target.value }))}
          />
          {fieldErrors.customer_phone ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.customer_phone}</span> : null}
        </label>

        <label className="text-sm">
          Pax*
          <input type="number" min={1} max={50} className="input-saas mt-1" value={form.pax}
            onChange={(e) => setForm((prev) => ({ ...prev, pax: e.target.value }))}
          />
          {fieldErrors.pax ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.pax}</span> : null}
        </label>

        {/* Hotel */}
        <div className="text-sm md:col-span-2">
          <div className="flex items-center justify-between">
            <span>Hotel / Struttura{isPrivateIsland ? "" : "*"}</span>
            <button type="button" onClick={() => setAddingHotel((v) => !v)} className="text-xs text-blue-600 hover:underline">
              {addingHotel ? "Annulla" : "+ Nuovo hotel"}
            </button>
          </div>
          {addingHotel ? (
            <div className="mt-2 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
              <input className="input-saas" placeholder="Nome hotel*" value={newHotelName} onChange={(e) => setNewHotelName(e.target.value)} />
              <input className="input-saas" placeholder="Indirizzo" value={newHotelAddress} onChange={(e) => setNewHotelAddress(e.target.value)} />
              <input className="input-saas" placeholder="Città" value={newHotelCity} onChange={(e) => setNewHotelCity(e.target.value)} />
              <button type="button" onClick={() => void createHotel()} disabled={savingHotel || !newHotelName.trim()} className="btn-primary w-full py-1.5 text-xs disabled:opacity-60">
                {savingHotel ? "Salvataggio..." : "Salva hotel"}
              </button>
            </div>
          ) : (
            <>
              <select className="input-saas mt-1" value={form.hotel_id} onChange={(e) => setForm((prev) => ({ ...prev, hotel_id: e.target.value }))}>
                {hotels.map((hotel) => (
                  <option key={hotel.id} value={hotel.id}>{hotel.name}{hotel.zone ? ` - ${hotel.zone}` : ""}</option>
                ))}
              </select>
              {fieldErrors.hotel_id ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.hotel_id}</span> : null}
            </>
          )}
        </div>

        {/* Hotel destinazione (transfer_hotel_hotel) */}
        {isTransferHotelHotel ? (
          <div className="text-sm md:col-span-2">
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

        {/* Selettore tratta A/R */}
        {showTripLeg ? (
          <div className="md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Tratta</span>
            <div className="mt-1 flex gap-2">
              {([
                { value: "outbound_only", label: "Solo andata" },
                { value: "round_trip", label: "A/R stesso giorno" },
                { value: "return_only", label: "Solo ritorno" },
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
                  className={`flex-1 rounded-xl border py-2 text-xs font-semibold transition ${tripLeg === value ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:border-slate-400"}`}
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
            {!(showTripLeg && tripLeg === "return_only") && <div className="md:col-span-2 grid grid-cols-2 gap-3">
              <label className="text-sm">
                {contextLabels.arrivalDateLabel}
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
              <label className="text-sm">
                {isSnavMedmar ? "Orario traghetto arrivo*" : contextLabels.arrivalTimeLabel}
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
            {!(showTripLeg && tripLeg === "outbound_only") && <div className="md:col-span-2 grid grid-cols-2 gap-3">
              <label className="text-sm">
                {contextLabels.departureDateLabel}
                <DateInput className={`input-saas mt-1${fieldErrors.departure_date ? " border-rose-400" : selectedKind === "bus_city_hotel" && form.departure_date && !isSunday(form.departure_date) ? " border-amber-400" : ""}`}
                  value={form.departure_date} min={form.arrival_date}
                  onChange={(iso) => { setForm((prev) => ({ ...prev, departure_date: iso })); setFieldErrors((prev) => { const n = { ...prev }; delete n.departure_date; return n; }); }}
                />
                {fieldErrors.departure_date ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.departure_date}</span> : null}
                {selectedKind === "bus_city_hotel" && form.departure_date && !isSunday(form.departure_date) ? (
                  <span className="mt-1 block text-xs text-amber-600">Le linee bus operano solo la domenica.</span>
                ) : null}
              </label>
              <label className="text-sm">
                {isSnavMedmar ? "Orario traghetto partenza*" : contextLabels.departureTimeLabel}
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
            <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs">
              <p className="font-semibold text-indigo-700 mb-0.5">Porto arrivo a Ischia</p>
              <p className="text-indigo-900 font-bold text-sm">{portoArrivo ?? "—"}</p>
              <p className="text-indigo-500 mt-0.5">Orario traghetto: {form.arrival_time}</p>
            </div>
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
          </div>
        )}

        {/* Orario prelevamento hotel */}
        {showPickupTime ? (
          <div className={`md:col-span-2 grid gap-3 ${isRoundTrip ? "grid-cols-2" : "grid-cols-1"}`}>
            <label className="text-sm">
              {isRoundTrip ? "Prelevamento andata" : "Orario prelevamento hotel"}
              <input type="time" className="input-saas mt-1" value={form.pickup_time_outbound}
                onChange={(e) => setForm((prev) => ({ ...prev, pickup_time_outbound: e.target.value }))}
              />
              <span className="mt-1 block text-xs text-slate-400">Facoltativo.</span>
            </label>
            {isRoundTrip ? (
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
            <label className={`text-sm ${contextLabels.transportCodeReturnLabel ? "" : "md:col-span-2"}`}>
              {contextLabels.transportCodeLabel}
              <input className="input-saas mt-1" placeholder={contextLabels.transportCodePlaceholder} value={form.transport_code}
                onChange={(e) => setForm((prev) => ({ ...prev, transport_code: e.target.value }))}
              />
              {!isTransportCodeRequired ? <span className="mt-1 block text-xs text-slate-500">Campo facoltativo.</span> : null}
              {fieldErrors.transport_code ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.transport_code}</span> : null}
            </label>
            {contextLabels.transportCodeReturnLabel ? (
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
            <input type="text" inputMode="decimal" placeholder="0.00" className="flex-1 bg-transparent outline-none text-sm py-2 pr-3 min-w-0"
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

        {message && !message.startsWith("Prenotazione creata") ? (
          <div className="md:col-span-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
            {message}
          </div>
        ) : null}
        {message && message.startsWith("Prenotazione creata") ? (
          <div className="md:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            {message}
          </div>
        ) : null}

        <button type="button" onClick={() => void submit()} disabled={submitting || !isFormValid}
          className="btn-primary md:col-span-2 disabled:opacity-60">
          {submitting ? "Creazione in corso..." : "Conferma prenotazione"}
        </button>
      </div>

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
                              router.push(`/services`);
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
