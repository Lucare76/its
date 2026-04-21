"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DateInput, PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

type ServiceRow = {
  id: string;
  customer_name: string | null;
  phone: string | null;
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
  transport_code: string | null;
  direction: string | null;
  booking_service_kind: string | null;
};
type HotelRow = { id: string; name: string };
type AgencyRow = { id: string; name: string };

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

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Inline hotel creation
  const [addingHotel, setAddingHotel] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [savingHotel, setSavingHotel] = useState(false);

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

      const [svcRes, hotelsRes, agenciesRes] = await Promise.all([
        supabase
          .from("services")
          .select("id, customer_name, phone, pax, time, notes, hotel_id, agency_id, billing_party_name, place_type, meeting_point, arrival_date, arrival_time, departure_date, departure_time, transport_code, direction, booking_service_kind")
          .eq("id", id)
          .eq("tenant_id", session.tenantId)
          .maybeSingle(),
        supabase
          .from("hotels")
          .select("id, name")
          .eq("tenant_id", session.tenantId)
          .order("name"),
        supabase
          .from("agencies")
          .select("id, name")
          .eq("tenant_id", session.tenantId)
          .eq("active", true)
          .order("name"),
      ]);

      if (!active) return;
      if (svcRes.error || !svcRes.data) {
        setInitError("Servizio non trovato.");
        setLoading(false);
        return;
      }

      const svc = svcRes.data as ServiceRow;
      setService(svc);
      setHotels((hotelsRes.data ?? []) as HotelRow[]);
      setAgencies((agenciesRes.data ?? []) as AgencyRow[]);

      setCustomerName(svc.customer_name ?? "");
      setPhone(svc.phone ?? "");
      setPax(String(svc.pax ?? 1));
      setTime((svc.time ?? "").slice(0, 5));
      setNotes(svc.notes ?? "");
      setHotelId(svc.hotel_id ?? "");
      setAgencyId(svc.agency_id ?? "");
      setMeetingPoint(svc.meeting_point ?? "");
      setArrivalDate(svc.arrival_date ?? "");
      setArrivalTime((svc.arrival_time ?? "").slice(0, 5));
      setDepartureDate(svc.departure_date ?? "");
      setDepartureTime((svc.departure_time ?? "").slice(0, 5));
      setTransportCode(svc.transport_code ?? "");

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
    if (!supabase || !tenantId || !service) return;
    if (time && !isValidTime(time)) { setError("Inserisci un orario valido nel formato HH:MM."); return; }
    setSaving(true);
    setError(null);
    const selectedAgency = agencies.find((a) => a.id === agencyId);
    const { error: err } = await supabase
      .from("services")
      .update({
        customer_name: customerName,
        phone: phone.trim() || null,
        pax: Number(pax) || 1,
        time: time.trim() || null,
        notes: notes.trim() || null,
        hotel_id: hotelId || null,
        agency_id: agencyId || null,
        billing_party_name: selectedAgency?.name ?? null,
        meeting_point: meetingPoint.trim() || null,
        arrival_date: arrivalDate || null,
        arrival_time: arrivalTime || null,
        departure_date: departureDate || null,
        departure_time: departureTime || null,
        transport_code: transportCode.trim() || null,
      })
      .eq("id", service.id)
      .eq("tenant_id", tenantId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    setSaved(true);
    setTimeout(() => router.back(), 1200);
  };

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
          <label className="text-xs font-medium text-slate-600">
            Orario
            <input type="time" step="300" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 input-saas w-full" />
          </label>

          {/* Telefono */}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Telefono
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
              <label className="text-xs font-medium text-slate-600">
                Data arrivo
                <DateInput value={arrivalDate} onChange={(iso) => setArrivalDate(iso)} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Ora arrivo
                <input type="time" step="300" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Data partenza
                <DateInput value={departureDate} onChange={(iso) => setDepartureDate(iso)} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Ora partenza
                <input type="time" step="300" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} className="mt-1 input-saas w-full" />
              </label>
            </div>
          </div>

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
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => router.back()} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            Annulla
          </button>
          <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
            {saving ? "Salvataggio..." : "Salva modifiche"}
          </button>
        </div>
      </div>
    </section>
  );
}
