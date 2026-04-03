import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest, type PricingAuthContext } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type PickupRun = {
  id: string;
  run_date: string;
  port: string;
  window_open: string;
  window_close: string;
  total_pax: number;
  status: string;
  notes: string | null;
  created_at: string;
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

// ── Caricamento dati ──────────────────────────────────────────────────────────

async function loadPickupRuns(auth: PricingAuthContext, date: string) {
  const tenantId = auth.membership.tenant_id;

  const [runsRes, arrivalsRes, busesRes, routingRes, vehiclesRes, driversRes] = await Promise.all([
    auth.admin
      .from("pickup_runs")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("run_date", date)
      .order("window_open"),
    auth.admin
      .from("pickup_run_arrivals")
      .select("*")
      .in(
        "run_id",
        (await auth.admin
          .from("pickup_runs")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("run_date", date)).data?.map((r: { id: string }) => r.id) ?? []
      )
      .order("arrival_time"),
    auth.admin
      .from("pickup_run_buses")
      .select("*")
      .in(
        "run_id",
        (await auth.admin
          .from("pickup_runs")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("run_date", date)).data?.map((r: { id: string }) => r.id) ?? []
      ),
    auth.admin
      .from("port_routing_rules")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("port")
      .order("sort_order"),
    auth.admin
      .from("vehicles")
      .select("id,label,plate,capacity,vehicle_size,active")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("label"),
    auth.admin
      .from("driver_profiles")
      .select("id,full_name,phone")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("full_name"),
  ]);

  if (runsRes.error) throw new Error(runsRes.error.message);

  return {
    runs: (runsRes.data ?? []) as PickupRun[],
    arrivals: (arrivalsRes.data ?? []) as PickupRunArrival[],
    buses: (busesRes.data ?? []) as PickupRunBus[],
    routing: (routingRes.data ?? []) as RoutingRule[],
    vehicles: vehiclesRes.data ?? [],
    drivers: driversRes.data ?? [],
  };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const data = await loadPickupRuns(auth, date);

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

      type SvcRow = { id: string; time: string | null; vessel: string | null; pax: number | null; hotel_id: string | null; notes: string | null; hotels: { zone: string | null } | null };

      // Filtra per porto: vessel o notes contiene il porto (case-insensitive)
      const portLower = port.toLowerCase();
      const filtered = ((services ?? []) as SvcRow[]).filter((s) => {
        const vessel = (s.vessel ?? "").toLowerCase();
        const notes = (s.notes ?? "").toLowerCase();
        return vessel.includes(portLower) || notes.includes(portLower);
      });

      const candidates: ArrivalCandidate[] = filtered.map((s) => ({
        id: s.id,
        time: s.time as string,
        vessel: s.vessel as string,
        pax: s.pax as number,
        hotel_zone: ((s as { hotels?: { zone?: string } | null }).hotels?.zone ?? null),
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
      const { port, window_open, window_close, notes } = body as {
        port: string;
        window_open: string;
        window_close: string;
        notes?: string;
      };
      if (!port || !window_open || !window_close)
        return NextResponse.json({ ok: false, error: "Campi obbligatori mancanti" }, { status: 400 });

      const { error } = await auth.admin.from("pickup_runs").insert({
        tenant_id: tenantId,
        run_date: date,
        port,
        window_open,
        window_close,
        total_pax: 0,
        status: "planned",
        notes: notes ?? null,
      });
      if (error) throw new Error(error.message);

      const data = await loadPickupRuns(auth, date);
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
      const { error } = await auth.admin.from("pickup_run_arrivals").delete().eq("id", arrival_id);
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
          .eq("id", bus_id);
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
      const { error } = await auth.admin.from("pickup_run_buses").delete().eq("id", bus_id);
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

      const { error } = await auth.admin.from("pickup_runs").update(update).eq("id", run_id);
      if (error) throw new Error(error.message);

      const data = await loadPickupRuns(auth, date);
      return NextResponse.json({ ok: true, ...data });
    }

    // ── delete_run ─────────────────────────────────────────────────────────
    if (action === "delete_run") {
      const { run_id } = body as { run_id: string };
      const { error } = await auth.admin.from("pickup_runs").delete().eq("id", run_id);
      if (error) throw new Error(error.message);

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
