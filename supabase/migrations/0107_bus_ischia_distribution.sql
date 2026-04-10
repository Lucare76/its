-- Migration 0107: Bus distribuzione Ischia per linea bus
-- Dopo lo sbarco dal traghetto, i clienti della linea bus vengono smistati
-- nei pullman dell'isola per raggiungere gli hotel per zona.

-- ── Bus di distribuzione Ischia ───────────────────────────────────────────────
create table if not exists public.bus_ischia_dist_buses (
  id           uuid    primary key default gen_random_uuid(),
  tenant_id    uuid    not null references public.tenants (id) on delete cascade,
  date         date    not null,
  bus_line_id  uuid    not null references public.tenant_bus_lines (id) on delete cascade,
  label        text    not null,          -- es. "Bus Forio", "Bus Ischia/Barano"
  zone         text    not null,          -- es. "forio", "ischia", "casamicciola"
  capacity     integer not null default 50,
  driver_name  text    null,
  driver_phone text    null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists idx_dist_buses_date_line
  on public.bus_ischia_dist_buses (tenant_id, date, bus_line_id);

alter table public.bus_ischia_dist_buses enable row level security;

create policy dist_buses_tenant_select on public.bus_ischia_dist_buses
  for select using (tenant_id = public.current_tenant_id());

create policy dist_buses_admin_all on public.bus_ischia_dist_buses
  for all
  using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
  with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

-- ── Allocazioni sui bus di distribuzione ──────────────────────────────────────
create table if not exists public.bus_ischia_dist_allocations (
  id            uuid    primary key default gen_random_uuid(),
  tenant_id     uuid    not null references public.tenants (id) on delete cascade,
  dist_bus_id   uuid    not null references public.bus_ischia_dist_buses (id) on delete cascade,
  service_id    uuid    not null references public.services (id) on delete cascade,
  pax_assigned  integer not null default 1,
  customer_name text    not null,
  hotel_name    text    not null,
  hotel_zone    text    not null,
  created_at    timestamptz not null default now(),
  unique (dist_bus_id, service_id)
);

create index if not exists idx_dist_alloc_bus
  on public.bus_ischia_dist_allocations (dist_bus_id);

create index if not exists idx_dist_alloc_service
  on public.bus_ischia_dist_allocations (service_id);

alter table public.bus_ischia_dist_allocations enable row level security;

create policy dist_alloc_tenant_select on public.bus_ischia_dist_allocations
  for select using (tenant_id = public.current_tenant_id());

create policy dist_alloc_admin_all on public.bus_ischia_dist_allocations
  for all
  using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
  with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
