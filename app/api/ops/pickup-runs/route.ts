import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest, type PricingAuthContext } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type PickupRun = {
  id: string;
  run_date: string;
  port: string;
  direction: "arrival" | "departure";
  window_open: string;
  window_close: string;
  total_pax: number;
  status: string;
  notes: string | null;
  bus_line_family_code: string | null;
  line_color: string | null;
  created_at: string;
};

type PickupRunPassenger = {
  id: string;
  run_id: string;
  service_id: string | null;
  passenger_name: string;
  passenger_phone: string | null;
  hotel_id: string | null;
  hotel_name: string;
  hotel_zone: string | null;
  pax: number;
  moved_to_dist_bus_id: string | null;
};

type BusLineFerryConfig = {
  id: string;
  bus_line_family_code: string;
  departure_port: string;
  arrival_port: string;
  departure_time: string;
  line_color: string;
  line_label: string;
  sort_order: number;
};

type DistBusAlert = {
  dist_bus_id: string;
  dist_bus_label: string;
  dist_bus_zone: string;
  line_label: string;
  line_color: string;
  free_seats: number;
  matching_passenger_ids: string[];
};

type PickupRunArrival = {
  id: string;
  run_id: string;
  service_id: string | null;
  ferry_name: string;
  arrival_time: string;
  pax: number;
  notes: string | null;
};

type PickupRunBus = {
  id: string;
  run_id: string;
  direction: string;
  direction_label: string;
  vehicle_id: string | null;
  driver_profile_id: string | null;
  pax_assigned: number;
  notes: string | null;
};

type RoutingRule = {
  id: string;
  port: string;
  direction: string;
  label: string;
  zone_filter: string[];
  sort_order: number;
};

// ── Algoritmo raggruppamento automatico ───────────────────────────────────────
// Finestra di 45 minuti: se due arrivi sono entro 45 min → stesso run.
const WINDOW_MINUTES = 45;

function toMinutes(timeStr: string): number {
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type ArrivalCandidate = {
  id: string;
  time: string;
  vessel: string;
  pax: number;
  hotel_zone: string | null;
};

function groupIntoRuns(
  arrivals: ArrivalCandidate[],
  port: string,
  routingRules: RoutingRule[]
): Array<{
  window_open: string;
  window_close: string;
  total_pax: number;
  arrivals: ArrivalCandidate[];
  buses: Array<{ direction: string; direction_label: string; pax_assigned: number }>;
}> {
  if (arrivals.length === 0) return [];

  const sorted = [...arrivals].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  const groups: ArrivalCandidate[][] = [];
  let current: ArrivalCandidate[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const lastInGroup = current[current.length - 1];
    if (toMinutes(sorted[i].time) - toMinutes(lastInGroup.time) <= WINDOW_MINUTES) {
      current.push(sorted[i]);
    } else {
      groups.push(current);
      current = [sorted[i]];
    }
  }
  groups.push(current);

  const portRules = routingRules.filter((r) => r.port === port).sort((a, b) => a.sort_order - b.sort_order);

  return groups.map((group) => {
    const firstTime = toMinutes(group[0].time);
    const lastTime = toMinutes(group[group.length - 1].time);
    const windowOpen = fromMinutes(Math.max(0, firstTime - 10));
    const windowClose = fromMinutes(lastTime + 30);
    const totalPax = group.reduce((s, a) => s + a.pax, 0);

    // Calcola pax per direzione geografica
    const buses = portRules.map((rule) => {
      const pax = group
        .filter((a) => {
          if (!a.hotel_zone) return false;
          return rule.zone_filter.some((z) => z.toLowerCase() === a.hotel_zone!.toLowerCase());
        })
        .reduce((s, a) => s + a.pax, 0);
      return { direction: rule.direction, direction_label: rule.label, pax_assigned: pax };
    });

    // Se una sola direzione o nessuno ha zona → metti tutti nella prima direzione
    const assignedPax = buses.reduce((s, b) => s + b.pax_assigned, 0);
    if (assignedPax === 0 && buses.length > 0) {
      buses[0] = { ...buses[0], pax_assigned: totalPax };
    }

    return { window_open: windowOpen, window_close: windowClose, total_pax: totalPax, arrivals: group, buses };
  });
}

// ── Verifica ownership tenant ─────────────────────────────────────────────────
// pickup_run_arrivals e pickup_run_buses non hanno tenant_id proprio: l'ownership
// deriva dal run_id (FK verso pickup_runs.tenant_id). Con client service-role
// (che bypassa la RLS) va verificata esplicitamente prima di ogni scrittura.
async function runBelongsToTenant(auth: PricingAuthContext, runId: string, tenantId: string): Promise<boolean> {
  const { data } = await auth.admin
    .from("pickup_runs")
    .select("id")
    .eq("id", runId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return !!data;
}

// ── Caricamento dati ──────────────────────────────────────────────────────────

async function loadPickupRuns(auth: PricingAuthContext, date: string, direction?: string) {
  const tenantId = auth.membership.tenant_id;

  // Carica i run (filtrati per direzione se specificata)
  let runsQuery = auth.admin
    .from("pickup_runs")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("run_date", date)
    .order("window_open");
  if (direction) runsQuery = runsQuery.eq("direction", direction);

  const runsRes = await runsQuery;
  if (runsRes.error) throw new Error(runsRes.error.message);
  const runIds = (runsRes.data ?? []).map((r: { id: string }) => r.id);

  const [arrivalsRes, busesRes, passengersRes, routingRes, vehiclesRes, driversRes, lineConfigRes, distBusesRes] =
    await Promise.all([
      runIds.length
        ? auth.admin.from("pickup_run_arrivals").select("*").in("run_id", runIds).order("arrival_time")
        : Promise.resolve({ data: [], error: null }),
      runIds.length
        ? auth.admin.from("pickup_run_buses").select("*").in("run_id", runIds)
        : Promise.resolve({ data: [], error: null }),
      runIds.length
        ? auth.admin.from("pickup_run_services").select("*").in("run_id", runIds).order("passenger_name")
        : Promise.resolve({ data: [], error: null }),
      auth.admin.from("port_routing_rules").select("*").eq("tenant_id", tenantId).order("port").order("sort_order"),
      auth.admin.from("vehicles").select("id,label,plate,capacity,vehicle_size,active").eq("tenant_id", tenantId).eq("active", true).order("label"),
      auth.admin.from("driver_profiles").select("id,full_name,phone").eq("tenant_id", tenantId).eq("active", true).order("full_name"),
      auth.admin.from("bus_line_ferry_config").select("*").eq("tenant_id", tenantId).order("sort_order"),
      // Bus smistamento del giorno per calcolo alert
      auth.admin
        .from("bus_ischia_dist_buses")
        .select("id,label,zone,capacity,bus_line_id,bus_ischia_dist_allocations(pax_assigned)")
        .eq("tenant_id", tenantId)
        .eq("date", date),
    ]);

  // Calcola alert per ogni run: bus smistamento con posti liberi verso stessa zona
  const passengers = (passengersRes.data ?? []) as PickupRunPassenger[];
  const distBuses = (distBusesRes.data ?? []) as Array<{
    id: string; label: string; zone: string; capacity: number; bus_line_id: string;
    bus_ischia_dist_allocations: Array<{ pax_assigned: number }>;
  }>;
  const lineConfigs = (lineConfigRes.data ?? []) as BusLineFerryConfig[];

  const alertsByRun: Record<string, DistBusAlert[]> = {};
  for (const run of (runsRes.data ?? []) as PickupRun[]) {
    const runPassengers = passengers.filter((p) => p.run_id === run.id && !p.moved_to_dist_bus_id);
    if (!runPassengers.length) continue;

    const alerts: DistBusAlert[] = [];
    for (const dbus of distBuses) {
      const used = dbus.bus_ischia_dist_allocations.reduce((s, a) => s + a.pax_assigned, 0);
      const free = dbus.capacity - used;
      if (free <= 0) continue;
      const matching = runPassengers.filter((p) => p.hotel_zone === dbus.zone);
      if (!matching.length) continue;
      // Trova label linea dal bus_line_id
      const lineConfig = lineConfigs.find((c) => c.arrival_port === run.port) ?? null;
      alerts.push({
        dist_bus_id: dbus.id,
        dist_bus_label: dbus.label,
        dist_bus_zone: dbus.zone,
        line_label: lineConfig?.line_label ?? "Linea Bus",
        line_color: lineConfig?.line_color ?? "#64748b",
        free_seats: free,
        matching_passenger_ids: matching.map((p) => p.id),
      });
    }
    if (alerts.length) alertsByRun[run.id] = alerts;
  }

  return {
    runs: (runsRes.data ?? []) as PickupRun[],
    arrivals: (arrivalsRes.data ?? []) as PickupRunArrival[],
    buses: (busesRes.data ?? []) as PickupRunBus[],
    passengers,
    routing: (routingRes.data ?? []) as RoutingRule[],
    vehicles: vehiclesRes.data ?? [],
    drivers: driversRes.data ?? [],
    line_configs: lineConfigs,
    alerts_by_run: alertsByRun,
  };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const direction = req.nextUrl.searchParams.get("direction") ?? undefined;
    const data = await loadPickupRuns(auth, date, direction);

    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;
    const date = (body.date as string) ?? new Date().toISOString().slice(0, 10);

    // ── auto_group: raggruppa automaticamente gli arrivi del giorno ────────
    if (action === "auto_group") {
      const port = body.port as string;
      if (!port) return NextResponse.json({ ok: false, error: "porto richiesto" }, { status: 400 });

      // Leggi servizi arrivo per quel giorno e porto
      // Il porto è nel campo vessel o notes — usiamo vessel per ora,
      // con fallback su notes ILIKE port
      const { data: services, error: svcErr } = await auth.admin
        .from("services")
        .select("id,time,vessel,pax,hotel_id,notes,hotels(zone)")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("direction", "arrival")
        .eq("is_draft", false);

      if (svcErr) throw new Error(svcErr.message);

      type SvcRow = {
        id: string;
        time: string | null;
        vessel: string | null;
        pax: number | null;
        hotel_id: string | null;
        notes: string | null;
        hotels: Array<{ zone: string | null }> | { zone: string | null } | null;
      };

      // Filtra per porto: vessel o notes contiene il porto (case-insensitive)
      const portLower = port.toLowerCase();
      const filtered = ((services ?? []) as unknown as SvcRow[]).filter((s) => {
        const vessel = (s.vessel ?? "").toLowerCase();
        const notes = (s.notes ?? "").toLowerCase();
        return vessel.includes(portLower) || notes.includes(portLower);
      });

      const candidates: ArrivalCandidate[] = filtered.map((s) => ({
        id: s.id,
        time: s.time as string,
        vessel: s.vessel as string,
        pax: s.pax as number,
        hotel_zone: (Array.isArray(s.hotels) ? (s.hotels[0]?.zone ?? null) : (s.hotels?.zone ?? null)),
      }));

      const { data: routingData } = await auth.admin
        .from("port_routing_rules")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("port")
        .order("sort_order");

      const routingRules = (routingData ?? []) as RoutingRule[];
      const groups = groupIntoRuns(candidates, port, routingRules);

      // Inserisci i run nel DB
      const createdRuns: PickupRun[] = [];
      for (const group of groups) {
        const { data: runData, error: runErr } = await auth.admin
          .from("pickup_runs")
          .insert({
            tenant_id: tenantId,
            run_date: date,
            port,
            window_open: group.window_open,
            window_close: group.window_close,
            total_pax: group.total_pax,
            status: "planned",
          })
          .select()
          .single();
        if (runErr) throw new Error(runErr.message);
        if (!runData) continue;
        createdRuns.push(runData as PickupRun);

        // Inserisci arrivi
        if (group.arrivals.length > 0) {
          await auth.admin.from("pickup_run_arrivals").insert(
            group.arrivals.map((a) => ({
              run_id: runData.id,
              service_id: a.id,
              ferry_name: a.vessel,
              arrival_time: a.time,
              pax: a.pax,
            }))
          );
        }

        // Inserisci bus per direzione (solo se pax > 0)
        const busesToInsert = group.buses.filter((b) => b.pax_assigned > 0);
        if (busesToInsert.length > 0) {
          await auth.admin.from("pickup_run_buses").insert(
            busesToInsert.map((b) => ({
              run_id: runData.id,
              direction: b.direction,
              direction_label: b.direction_label,
              pax_assigned: b.pax_assigned,
            }))
          );
        }
      }

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, created: createdRuns.length, ...data });
    }

    // ── create_run: crea run manuale ───────────────────────────────────────
    if (action === "create_run") {
      const { port, window_open, window_close, notes, direction: runDirection, bus_line_family_code, line_color } = body as {
        port: string;
        window_open: string;
        window_close: string;
        notes?: string;
        direction?: string;
        bus_line_family_code?: string;
        line_color?: string;
      };
      if (!port || !window_open || !window_close)
        return NextResponse.json({ ok: false, error: "Campi obbligatori mancanti" }, { status: 400 });

      const { error } = await auth.admin.from("pickup_runs").insert({
        tenant_id: tenantId,
        run_date: date,
        port,
        direction: runDirection ?? "arrival",
        window_open,
        window_close,
        total_pax: 0,
        status: "planned",
        notes: notes ?? null,
        bus_line_family_code: bus_line_family_code ?? null,
        line_color: line_color ?? null,
      });
      if (error) throw new Error(error.message);

      const data = await loadPickupRuns(auth, date, runDirection);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── move_to_dist_bus: sposta passeggero Transfer Ischia su bus smistamento ─
    if (action === "move_to_dist_bus") {
      const { run_service_id, dist_bus_id } = body as { run_service_id: string; dist_bus_id: string };
      if (!run_service_id || !dist_bus_id)
        return NextResponse.json({ ok: false, error: "Campi obbligatori mancanti" }, { status: 400 });

      const { data: rs } = await auth.admin
        .from("pickup_run_services")
        .select("service_id, passenger_name, hotel_name, hotel_zone, pax, run_id")
        .eq("id", run_service_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!rs) return NextResponse.json({ ok: false, error: "Passeggero non trovato." }, { status: 404 });

      const { data: distBus } = await auth.admin
        .from("bus_ischia_dist_buses")
        .select("id")
        .eq("id", dist_bus_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!distBus) return NextResponse.json({ ok: false, error: "Bus smistamento non trovato." }, { status: 404 });

      // Crea allocazione sul bus smistamento
      const { error: allocErr } = await auth.admin.from("bus_ischia_dist_allocations").insert({
        tenant_id: tenantId,
        dist_bus_id,
        service_id: rs.service_id,
        pax_assigned: rs.pax,
        customer_name: rs.passenger_name,
        hotel_name: rs.hotel_name,
        hotel_zone: rs.hotel_zone ?? "",
      });
      if (allocErr) throw new Error(allocErr.message);

      // Segna come spostato
      const { error: moveErr } = await auth.admin
        .from("pickup_run_services")
        .update({ moved_to_dist_bus_id: dist_bus_id })
        .eq("id", run_service_id)
        .eq("tenant_id", tenantId);
      if (moveErr) throw new Error(moveErr.message);

      // Trova run per ricaricare con la giusta direction
      const { data: runRow } = await auth.admin
        .from("pickup_runs")
        .select("direction")
        .eq("id", rs.run_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      const data = await loadPickupRuns(auth, date, runRow?.direction ?? undefined);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── add_arrival: aggiungi traghetto a un run ────────────────────────────
    if (action === "add_arrival") {
      const { run_id, ferry_name, arrival_time, pax, service_id, notes } = body as {
        run_id: string;
        ferry_name: string;
        arrival_time: string;
        pax: number;
        service_id?: string;
        notes?: string;
      };
      if (!run_id || !ferry_name || !arrival_time)
        return NextResponse.json({ ok: false, error: "Campi obbligatori mancanti" }, { status: 400 });

      if (!(await runBelongsToTenant(auth, run_id, tenantId)))
        return NextResponse.json({ ok: false, error: "Run non trovato." }, { status: 404 });

      const { error } = await auth.admin.from("pickup_run_arrivals").insert({
        run_id,
        ferry_name,
        arrival_time,
        pax: pax ?? 0,
        service_id: service_id ?? null,
        notes: notes ?? null,
      });
      if (error) throw new Error(error.message);

      // Ricalcola total_pax
      const { data: allArrivals } = await auth.admin
        .from("pickup_run_arrivals")
        .select("pax")
        .eq("run_id", run_id);
      const totalPax = (allArrivals ?? []).reduce((s: number, a: { pax: number | null }) => s + (a.pax ?? 0), 0);
      await auth.admin.from("pickup_runs").update({ total_pax: totalPax }).eq("id", run_id);

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── remove_arrival: rimuovi traghetto da un run ─────────────────────────
    if (action === "remove_arrival") {
      const { arrival_id, run_id } = body as { arrival_id: string; run_id: string };

      if (!(await runBelongsToTenant(auth, run_id, tenantId)))
        return NextResponse.json({ ok: false, error: "Run non trovato." }, { status: 404 });

      const { error } = await auth.admin
        .from("pickup_run_arrivals")
        .delete()
        .eq("id", arrival_id)
        .eq("run_id", run_id);
      if (error) throw new Error(error.message);

      const { data: allArrivals } = await auth.admin
        .from("pickup_run_arrivals")
        .select("pax")
        .eq("run_id", run_id);
      const totalPax = (allArrivals ?? []).reduce((s: number, a: { pax: number | null }) => s + (a.pax ?? 0), 0);
      await auth.admin.from("pickup_runs").update({ total_pax: totalPax }).eq("id", run_id);

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── upsert_bus: assegna/aggiorna bus per direzione ─────────────────────
    if (action === "upsert_bus") {
      const { run_id, direction, direction_label, vehicle_id, driver_profile_id, pax_assigned, notes, bus_id } =
        body as {
          run_id: string;
          direction: string;
          direction_label: string;
          vehicle_id?: string;
          driver_profile_id?: string;
          pax_assigned?: number;
          notes?: string;
          bus_id?: string;
        };

      if (!(await runBelongsToTenant(auth, run_id, tenantId)))
        return NextResponse.json({ ok: false, error: "Run non trovato." }, { status: 404 });

      if (bus_id) {
        // update esistente
        const { error } = await auth.admin
          .from("pickup_run_buses")
          .update({
            vehicle_id: vehicle_id ?? null,
            driver_profile_id: driver_profile_id ?? null,
            pax_assigned: pax_assigned ?? 0,
            notes: notes ?? null,
          })
          .eq("id", bus_id)
          .eq("run_id", run_id);
        if (error) throw new Error(error.message);
      } else {
        // insert nuovo
        const { error } = await auth.admin.from("pickup_run_buses").insert({
          run_id,
          direction,
          direction_label,
          vehicle_id: vehicle_id ?? null,
          driver_profile_id: driver_profile_id ?? null,
          pax_assigned: pax_assigned ?? 0,
          notes: notes ?? null,
        });
        if (error) throw new Error(error.message);
      }

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── remove_bus: rimuovi bus da run ─────────────────────────────────────
    if (action === "remove_bus") {
      const { bus_id } = body as { bus_id: string };

      const { data: busRow } = await auth.admin
        .from("pickup_run_buses")
        .select("run_id")
        .eq("id", bus_id)
        .maybeSingle();
      if (!busRow || !(await runBelongsToTenant(auth, busRow.run_id, tenantId)))
        return NextResponse.json({ ok: false, error: "Bus non trovato." }, { status: 404 });

      const { error } = await auth.admin
        .from("pickup_run_buses")
        .delete()
        .eq("id", bus_id)
        .eq("run_id", busRow.run_id);
      if (error) throw new Error(error.message);

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── update_run: aggiorna stato/note ────────────────────────────────────
    if (action === "update_run") {
      const { run_id, status, notes } = body as {
        run_id: string;
        status?: string;
        notes?: string;
      };
      const update: Record<string, unknown> = {};
      if (status !== undefined) update.status = status;
      if (notes !== undefined) update.notes = notes;

      const { data: updated, error } = await auth.admin
        .from("pickup_runs")
        .update(update)
        .eq("id", run_id)
        .eq("tenant_id", tenantId)
        .select("id");
      if (error) throw new Error(error.message);
      if (!updated || updated.length === 0)
        return NextResponse.json({ ok: false, error: "Run non trovato." }, { status: 404 });

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── delete_run ─────────────────────────────────────────────────────────
    if (action === "delete_run") {
      const { run_id } = body as { run_id: string };
      const { data: deleted, error } = await auth.admin
        .from("pickup_runs")
        .delete()
        .eq("id", run_id)
        .eq("tenant_id", tenantId)
        .select("id");
      if (error) throw new Error(error.message);
      if (!deleted || deleted.length === 0)
        return NextResponse.json({ ok: false, error: "Run non trovato." }, { status: 404 });

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
