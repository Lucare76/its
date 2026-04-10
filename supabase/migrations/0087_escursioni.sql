-- Migration 0087: Sistema escursioni
-- Struttura simile a bus_network: linee → bus (units) → passeggeri (allocations)

-- ── Tipi di escursione ────────────────────────────────────────────────────────
create table if not exists public.excursion_lines (
  id          uuid    primary key default gen_random_uuid(),
  tenant_id   uuid    not null references public.tenants (id) on delete cascade,
  name        text    not null,
  description text    null,
  color       text    not null default '#6366f1',  -- colore UI (hex)
  icon        text    not null default '🚌',
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_excursion_lines_tenant on public.excursion_lines (tenant_id);

alter table public.excursion_lines enable row level security;

drop policy if exists excursion_lines_tenant_select on public.excursion_lines;
create policy excursion_lines_tenant_select on public.excursion_lines
for select using (tenant_id = public.current_tenant_id());

drop policy if exists excursion_lines_admin_all on public.excursion_lines;
create policy excursion_lines_admin_all on public.excursion_lines
for all
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'));

-- ── Bus per escursione per data ───────────────────────────────────────────────
create table if not exists public.excursion_units (
  id                  uuid    primary key default gen_random_uuid(),
  tenant_id           uuid    not null references public.tenants (id) on delete cascade,
  excursion_line_id   uuid    not null references public.excursion_lines (id) on delete cascade,
  excursion_date      date    not null,
  label               text    not null,    -- es. 'Bus 1', 'Bus Giallo'
  capacity            integer not null default 50,
  departure_time      time    null,
  vehicle_id          uuid    null references public.vehicles (id) on delete set null,
  driver_profile_id   uuid    null references public.driver_profiles (id) on delete set null,
  notes               text    null,
  status              text    not null default 'open'
                        check (status in ('open','full','completed','cancelled')),
  created_at          timestamptz not null default now()
);

create index if not exists idx_excursion_units_tenant_date
  on public.excursion_units (tenant_id, excursion_date);
create index if not exists idx_excursion_units_line_date
  on public.excursion_units (excursion_line_id, excursion_date);

alter table public.excursion_units enable row level security;

drop policy if exists excursion_units_tenant_select on public.excursion_units;
create policy excursion_units_tenant_select on public.excursion_units
for select using (tenant_id = public.current_tenant_id());

drop policy if exists excursion_units_admin_all on public.excursion_units;
create policy excursion_units_admin_all on public.excursion_units
for all
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'));

-- ── Passeggeri per bus escursione ─────────────────────────────────────────────
create table if not exists public.excursion_allocations (
  id                  uuid    primary key default gen_random_uuid(),
  excursion_unit_id   uuid    not null references public.excursion_units (id) on delete cascade,
  customer_name       text    not null,
  pax                 integer not null default 1,
  hotel_name          text    null,
  pickup_time         time    null,
  phone               text    null,
  agency_name         text    null,
  notes               text    null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_excursion_allocations_unit
  on public.excursion_allocations (excursion_unit_id);

alter table public.excursion_allocations enable row level security;

drop policy if exists excursion_allocations_tenant_select on public.excursion_allocations;
create policy excursion_allocations_tenant_select on public.excursion_allocations
for select using (
  exists (
    select 1 from public.excursion_units u
    where u.id = excursion_allocations.excursion_unit_id
    and u.tenant_id = public.current_tenant_id()
  )
);

drop policy if exists excursion_allocations_admin_all on public.excursion_allocations;
create policy excursion_allocations_admin_all on public.excursion_allocations
for all
using (
  exists (
    select 1 from public.excursion_units u
    where u.id = excursion_allocations.excursion_unit_id
    and u.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin','operator')
  )
)
with check (
  exists (
    select 1 from public.excursion_units u
    where u.id = excursion_allocations.excursion_unit_id
    and u.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin','operator')
  )
);

-- ── Seed 5 escursioni Ischia Transfer Service ─────────────────────────────────
insert into public.excursion_lines (tenant_id, name, description, color, icon, sort_order)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Giro dell''Isola', 'Tour panoramico completo dell''isola', '#6366f1', '🏝️', 1),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Epomeo', 'Escursione al Monte Epomeo', '#16a34a', '⛰️', 2),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Foresta di Notte', 'Escursione serale nella foresta', '#7c3aed', '🌙', 3),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Terme e Relax', 'Visita ai parchi termali', '#0891b2', '♨️', 4),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Castelli e Musei', 'Tour culturale castelli e musei dell''isola', '#b45309', '🏰', 5)
on conflict do nothing;
