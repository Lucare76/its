-- Migration 0085: Sistema corse porto (pickup runs)
-- Raggruppa arrivi traghetto vicini nel tempo in una corsa combinata.
-- Il routing geografico dipende dal porto di arrivo e dalla zona hotel.

-- ── Regole di routing porto → direzione geografica ────────────────────────────
create table if not exists public.port_routing_rules (
  id          uuid    primary key default gen_random_uuid(),
  tenant_id   uuid    not null references public.tenants (id) on delete cascade,
  port        text    not null,       -- es. 'casamicciola', 'ischia', 'napoli'
  direction   text    not null,       -- es. 'ovest', 'est', 'locale', 'cross_island'
  label       text    not null,       -- etichetta UI es. 'Verso Forio/Lacco'
  zone_filter text[]  not null,       -- zone hotel coperte da questa direzione
  sort_order  integer not null default 0
);

create unique index if not exists port_routing_rules_port_direction_tenant
  on public.port_routing_rules (tenant_id, port, direction);

alter table public.port_routing_rules enable row level security;

drop policy if exists port_routing_rules_tenant_select on public.port_routing_rules;
create policy port_routing_rules_tenant_select on public.port_routing_rules
for select using (tenant_id = public.current_tenant_id());

drop policy if exists port_routing_rules_admin_all on public.port_routing_rules;
create policy port_routing_rules_admin_all on public.port_routing_rules
for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── Seed regole routing Ischia Transfer Service ───────────────────────────────
-- Porto di Casamicciola:
--   ovest  → Forio, Lacco Ameno, Casamicciola, Sant'Angelo
--   est    → Ischia, Barano
-- Porto di Ischia:
--   locale      → Ischia, Barano (hotel locali)
--   cross_island → Casamicciola, Lacco, Forio, Sant'Angelo (direzione opposta)
insert into public.port_routing_rules (tenant_id, port, direction, label, zone_filter, sort_order)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'casamicciola', 'ovest',
   'Casamicciola → Forio / Lacco / Sant''Angelo',
   array['forio','lacco','casamicciola','sant''angelo','serrara'], 1),

  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'casamicciola', 'est',
   'Casamicciola → Ischia / Barano',
   array['ischia','barano'], 2),

  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ischia', 'locale',
   'Ischia Porto → Hotel Ischia / Barano',
   array['ischia','barano'], 1),

  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ischia', 'cross_island',
   'Ischia Porto → Casamicciola / Lacco / Forio / Sant''Angelo',
   array['casamicciola','lacco','forio','sant''angelo','serrara'], 2),

  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'napoli', 'isola',
   'Napoli → Tutta l''isola',
   array['ischia','barano','casamicciola','lacco','forio','sant''angelo','serrara'], 1),

  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'pozzuoli', 'isola',
   'Pozzuoli → Tutta l''isola',
   array['ischia','barano','casamicciola','lacco','forio','sant''angelo','serrara'], 1)

on conflict (tenant_id, port, direction) do update set
  label       = excluded.label,
  zone_filter = excluded.zone_filter,
  sort_order  = excluded.sort_order;

-- ── Corse porto (pickup runs) ─────────────────────────────────────────────────
create table if not exists public.pickup_runs (
  id           uuid    primary key default gen_random_uuid(),
  tenant_id    uuid    not null references public.tenants (id) on delete cascade,
  run_date     date    not null,
  port         text    not null,
  window_open  time    not null,   -- apertura finestra (es. 10 min prima del primo traghetto)
  window_close time    not null,   -- chiusura finestra (es. 45 min dopo l'ultimo traghetto)
  total_pax    integer not null default 0,
  status       text    not null default 'planned'
                check (status in ('planned','active','completed','cancelled')),
  notes        text    null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_pickup_runs_tenant_date
  on public.pickup_runs (tenant_id, run_date);

alter table public.pickup_runs enable row level security;

drop policy if exists pickup_runs_tenant_select on public.pickup_runs;
create policy pickup_runs_tenant_select on public.pickup_runs
for select using (tenant_id = public.current_tenant_id());

drop policy if exists pickup_runs_admin_operator_all on public.pickup_runs;
create policy pickup_runs_admin_operator_all on public.pickup_runs
for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── Traghetti/arrivi inclusi nel run ─────────────────────────────────────────
create table if not exists public.pickup_run_arrivals (
  id           uuid    primary key default gen_random_uuid(),
  run_id       uuid    not null references public.pickup_runs (id) on delete cascade,
  service_id   uuid    null references public.services (id) on delete set null,
  ferry_name   text    not null,
  arrival_time time    not null,
  pax          integer not null default 0,
  notes        text    null
);

create index if not exists idx_pickup_run_arrivals_run_id
  on public.pickup_run_arrivals (run_id);

alter table public.pickup_run_arrivals enable row level security;

drop policy if exists pickup_run_arrivals_select on public.pickup_run_arrivals;
create policy pickup_run_arrivals_select on public.pickup_run_arrivals
for select using (
  exists (
    select 1 from public.pickup_runs r
    where r.id = pickup_run_arrivals.run_id
    and r.tenant_id = public.current_tenant_id()
  )
);

drop policy if exists pickup_run_arrivals_admin_all on public.pickup_run_arrivals;
create policy pickup_run_arrivals_admin_all on public.pickup_run_arrivals
for all
using (
  exists (
    select 1 from public.pickup_runs r
    where r.id = pickup_run_arrivals.run_id
    and r.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
)
with check (
  exists (
    select 1 from public.pickup_runs r
    where r.id = pickup_run_arrivals.run_id
    and r.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
);

-- ── Bus assegnati per direzione geografica nel run ────────────────────────────
create table if not exists public.pickup_run_buses (
  id                uuid    primary key default gen_random_uuid(),
  run_id            uuid    not null references public.pickup_runs (id) on delete cascade,
  direction         text    not null,    -- 'ovest','est','locale','cross_island','isola'
  direction_label   text    not null,
  vehicle_id        uuid    null references public.vehicles (id) on delete set null,
  driver_profile_id uuid    null references public.driver_profiles (id) on delete set null,
  pax_assigned      integer not null default 0,
  notes             text    null
);

create index if not exists idx_pickup_run_buses_run_id
  on public.pickup_run_buses (run_id);

alter table public.pickup_run_buses enable row level security;

drop policy if exists pickup_run_buses_select on public.pickup_run_buses;
create policy pickup_run_buses_select on public.pickup_run_buses
for select using (
  exists (
    select 1 from public.pickup_runs r
    where r.id = pickup_run_buses.run_id
    and r.tenant_id = public.current_tenant_id()
  )
);

drop policy if exists pickup_run_buses_admin_all on public.pickup_run_buses;
create policy pickup_run_buses_admin_all on public.pickup_run_buses
for all
using (
  exists (
    select 1 from public.pickup_runs r
    where r.id = pickup_run_buses.run_id
    and r.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
)
with check (
  exists (
    select 1 from public.pickup_runs r
    where r.id = pickup_run_buses.run_id
    and r.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
);
