"use client";

import { useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { calculateDriverSuggestions } from "@/lib/dispatch-driver-scoring";
import { useDemoStore } from "@/lib/use-demo-store";
import { assignmentSchema } from "@/lib/validation";

function suggestedVehicleByPax(pax: number) {
  return pax >= 6 ? "VAN" : "CAR";
}

export default function DispatchPage() {
  const { state, loading, assignDriver } = useDemoStore();
  const [serviceId, setServiceId] = useState<string>("");
  const [driverId, setDriverId] = useState<string>("");
  const [vehicleLabel, setVehicleLabel] = useState("Mercedes Vito - AA123BB");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("Assegna driver e mezzo ai servizi.");

  const tenantId = useMemo(() => {
    const fromService = state.services.find((service) => service.id === serviceId)?.tenant_id;
    return fromService ?? state.memberships[0]?.tenant_id ?? state.services[0]?.tenant_id ?? null;
  }, [serviceId, state.memberships, state.services]);

  const tenantMemberships = tenantId ? state.memberships.filter((member) => member.tenant_id === tenantId) : state.memberships;
  const drivers = tenantMemberships.filter((member) => member.role === "driver");
  const tenantServices = tenantId ? state.services.filter((service) => service.tenant_id === tenantId) : state.services;
  const tenantAssignments = tenantId ? state.assignments.filter((assignment) => assignment.tenant_id === tenantId) : state.assignments;
  const assignmentByServiceId = new Map(tenantAssignments.map((assignment) => [assignment.service_id, assignment]));
  const servicesToAssign = tenantServices.filter((service) => service.status === "new" || service.status === "assigned");
  const tenantHotels = tenantId ? state.hotels.filter((hotel) => hotel.tenant_id === tenantId) : state.hotels;
  const hotelsById = new Map(tenantHotels.map((hotel) => [hotel.id, hotel]));

  const sortedServices = [...servicesToAssign].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });

  const selectedService = sortedServices.find((service) => service.id === serviceId) ?? sortedServices[0] ?? null;
  const selectedServiceZone = selectedService ? hotelsById.get(selectedService.hotel_id)?.zone ?? null : null;
  const suggestions = calculateDriverSuggestions({
    drivers,
    assignments: tenantAssignments,
    services: tenantServices,
    hotels: tenantHotels,
    selectedService
  }).slice(0, 3);
  const selectedAssignment = selectedService ? assignmentByServiceId.get(selectedService.id) : null;
  const resolvedDriverId = driverId || selectedAssignment?.driver_user_id || "";
  const resolvedVehicleLabel =
    vehicleLabel || selectedAssignment?.vehicle_label || (selectedService ? suggestedVehicleByPax(selectedService.pax) : "");

  const persistAssignment = async (nextServiceId: string, nextDriverId: string, nextVehicleLabel: string) => {
    if (!hasSupabaseEnv || !supabase) return null;

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) return "Utente non autenticato";

    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (membershipError || !membership?.tenant_id) return "Tenant non trovato";

    const existing = tenantAssignments.find((item) => item.service_id === nextServiceId && item.tenant_id === membership.tenant_id);

    if (existing) {
      const { error: updateAssignmentError } = await supabase
        .from("assignments")
        .update({ driver_user_id: nextDriverId, vehicle_label: nextVehicleLabel })
        .eq("id", existing.id)
        .eq("tenant_id", membership.tenant_id);
      if (updateAssignmentError) return updateAssignmentError.message;
    } else {
      const { error: insertAssignmentError } = await supabase.from("assignments").insert({
        tenant_id: membership.tenant_id,
        service_id: nextServiceId,
        driver_user_id: nextDriverId,
        vehicle_label: nextVehicleLabel
      });
      if (insertAssignmentError) return insertAssignmentError.message;
    }

    const { error: updateServiceError } = await supabase
      .from("services")
      .update({ status: "assigned" })
      .eq("id", nextServiceId)
      .eq("tenant_id", membership.tenant_id)
      .neq("status", "assigned");

    if (updateServiceError) return updateServiceError.message;

    const { data: existingEvent, error: eventReadError } = await supabase
      .from("status_events")
      .select("id")
      .eq("tenant_id", membership.tenant_id)
      .eq("service_id", nextServiceId)
      .eq("status", "assigned")
      .maybeSingle();

    if (eventReadError) return eventReadError.message;

    if (!existingEvent) {
      const { error: eventInsertError } = await supabase.from("status_events").insert({
        tenant_id: membership.tenant_id,
        service_id: nextServiceId,
        status: "assigned",
        by_user_id: userData.user.id
      });
      if (eventInsertError) return eventInsertError.message;
    }

    return null;
  };

  const runAssign = async (nextServiceId: string, nextDriverId: string, nextVehicleLabel: string) => {
    setSaving(true);

    const payload = {
      service_id: nextServiceId,
      driver_user_id: nextDriverId,
      vehicle_label: nextVehicleLabel
    };
    const parsed = assignmentSchema.safeParse(payload);
    if (!parsed.success) {
      setSaving(false);
      setMessage(parsed.error.errors[0]?.message ?? "Dati dispatch non validi.");
      return;
    }

    const persistenceError = await persistAssignment(parsed.data.service_id, parsed.data.driver_user_id, parsed.data.vehicle_label);
    if (persistenceError) {
      setSaving(false);
      setMessage(`Errore salvataggio: ${persistenceError}`);
      return;
    }

    assignDriver(parsed.data.service_id, parsed.data.driver_user_id, parsed.data.vehicle_label);
    setSaving(false);
    setMessage("Assegnazione salvata.");
  };

  const submit = (formData: FormData) => {
    const nextServiceId = String(formData.get("service_id"));
    const nextDriverId = String(formData.get("driver_user_id"));
    const nextVehicleLabel = String(formData.get("vehicle_label"));
    void runAssign(nextServiceId, nextDriverId, nextVehicleLabel);
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento dispatch...</div>;

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-4xl md:text-5xl">Dispatch / Assegnazione</h1>
        <p className="mt-1 text-sm text-muted">Assegna driver e veicolo in modo rapido e chiaro.</p>
      </div>
      <form action={submit} className="card grid gap-6 p-7">
        <h2 className="text-base">Dettagli assegnazione</h2>
        <label className="text-sm">
          Servizio
          <select
            name="service_id"
            value={selectedService?.id ?? ""}
            onChange={(event) => {
              setServiceId(event.target.value);
              setDriverId("");
              const changed = sortedServices.find((service) => service.id === event.target.value);
              if (changed) {
                const existing = assignmentByServiceId.get(changed.id);
                setVehicleLabel(existing?.vehicle_label ?? suggestedVehicleByPax(changed.pax));
              }
            }}
            className="input-saas mt-1 w-full"
          >
            {sortedServices.map((service) => (
              <option key={service.id} value={service.id}>
                {service.date} {service.time} - {service.customer_name} [{service.service_type ?? "transfer"}] ({service.status})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Driver
          <select
            name="driver_user_id"
            value={resolvedDriverId}
            onChange={(event) => setDriverId(event.target.value)}
            className="input-saas mt-1 w-full"
          >
            <option value="">Seleziona driver</option>
            {drivers.map((driver) => (
              <option key={driver.user_id} value={driver.user_id}>
                {driver.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Mezzo
          <input
            name="vehicle_label"
            value={resolvedVehicleLabel}
            onChange={(event) => setVehicleLabel(event.target.value)}
            className="input-saas mt-1 w-full"
          />
        </label>
        <button type="submit" disabled={saving} className="btn-primary px-5 py-3 text-base disabled:opacity-50">
          {saving ? "Salvataggio..." : "Conferma assegnazione"}
        </button>
      </form>
      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Suggested drivers (Top 3)</h2>
          {selectedService ? (
            <p className="text-xs text-muted">
              Pickup zone: {selectedServiceZone ?? "N/D"} | Service: {selectedService.customer_name}
            </p>
          ) : null}
        </div>
        <article className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Criteri scoring: 1) prossimita hotel/zona pickup, 2) carico lavoro giornaliero (assegnazioni), 3) disponibilita
          (job in corso e conflitti orari). Nessuna assegnazione automatica: i suggerimenti sono solo di supporto.
        </article>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted">Nessun suggerimento disponibile.</p>
        ) : (
          <div className="space-y-2">
            {suggestions.map((item, index) => (
              <article key={item.userId} className="rounded-xl border border-border bg-white px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    #{index + 1} {item.fullName}
                  </p>
                  <p className="text-sm text-muted">
                    Score {item.score} (prox {item.proximityScore} | load {item.loadScore} | avail {item.availabilityScore})
                  </p>
                </div>
                <ul className="mt-1 text-xs text-muted">
                  {item.reasons.map((reason) => (
                    <li key={reason}>- {reason}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="text-sm text-muted">{message}</p>
    </section>
  );
}
