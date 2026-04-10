alter table public.vehicles
  add column if not exists vehicle_size text null
    check (vehicle_size is null or vehicle_size in ('small', 'medium', 'large', 'bus')),
  add column if not exists habitual_driver_user_id uuid null references auth.users (id) on delete set null,
  add column if not exists default_zone text null,
  add column if not exists blocked_until timestamptz null,
  add column if not exists blocked_reason text null,
  add column if not exists notes text null,
  add column if not exists is_blocked_manual boolean not null default false;

create table if not exists public.tenant_bus_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code text not null,
  name text not null,
  family_code text not null,
  family_name text not null,
  variant_label text null,
  default_capacity integer not null default 54 check (default_capacity between 1 and 120),
  alert_threshold integer not null default 5 check (alert_threshold between 0 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists public.tenant_bus_line_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  bus_line_id uuid not null references public.tenant_bus_lines (id) on delete cascade,
  direction public.service_direction not null,
  stop_name text not null,
  city text not null,
  pickup_note text null,
  stop_order integer not null check (stop_order >= 1),
  lat double precision null,
  lng double precision null,
  is_manual boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bus_line_id, direction, stop_name)
);

create table if not exists public.tenant_bus_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  bus_line_id uuid not null references public.tenant_bus_lines (id) on delete cascade,
  label text not null,
  capacity integer not null check (capacity between 1 and 120),
  low_seat_threshold integer not null default 5 check (low_seat_threshold between 0 and 120),
  minimum_passengers integer null check (minimum_passengers is null or minimum_passengers between 1 and 120),
  status text not null default 'open' check (status in ('open', 'low', 'closed', 'completed')),
  manual_close boolean not null default false,
  close_reason text null,
  sort_order integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, bus_line_id, label)
);

create table if not exists public.tenant_bus_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  bus_line_id uuid not null references public.tenant_bus_lines (id) on delete cascade,
  bus_unit_id uuid not null references public.tenant_bus_units (id) on delete cascade,
  stop_id uuid null references public.tenant_bus_line_stops (id) on delete set null,
  stop_name text not null,
  direction public.service_direction not null,
  pax_assigned integer not null check (pax_assigned > 0 and pax_assigned <= 120),
  notes text null,
  created_by_user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_bus_allocation_moves (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  from_bus_unit_id uuid null references public.tenant_bus_units (id) on delete set null,
  to_bus_unit_id uuid null references public.tenant_bus_units (id) on delete set null,
  stop_name text null,
  pax_moved integer not null check (pax_moved > 0 and pax_moved <= 120),
  reason text null,
  created_by_user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicle_anomalies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  vehicle_id uuid not null references public.vehicles (id) on delete cascade,
  driver_user_id uuid null references auth.users (id) on delete set null,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'blocking')),
  title text not null,
  description text null,
  blocked_until timestamptz null,
  active boolean not null default true,
  resolved_at timestamptz null,
  resolved_by_user_id uuid null references auth.users (id) on delete set null,
  reported_at timestamptz not null default now()
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_by_user_id uuid null references auth.users (id) on delete set null,
  owner_label text not null default 'owen',
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  service_kind text not null,
  route_label text not null,
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'EUR',
  passenger_count integer null check (passenger_count is null or passenger_count between 1 and 120),
  valid_until date null,
  notes text null,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_waypoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  label text not null,
  sort_order integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_user_feature_flags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  feature_code text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, feature_code)
);

alter table public.tenant_whatsapp_settings
  add column if not exists enable_arrival_messages boolean not null default false,
  add column if not exists arrival_template text not null default 'arrival_welcome',
  add column if not exists arrival_notice_minutes integer not null default 90 check (arrival_notice_minutes between 5 and 1440);

create index if not exists idx_tenant_bus_lines_tenant_family on public.tenant_bus_lines (tenant_id, family_code, active);
create index if not exists idx_tenant_bus_line_stops_line_direction on public.tenant_bus_line_stops (bus_line_id, direction, stop_order);
create index if not exists idx_tenant_bus_units_line_status on public.tenant_bus_units (bus_line_id, status, active);
create index if not exists idx_tenant_bus_allocations_unit on public.tenant_bus_allocations (tenant_id, bus_unit_id, direction);
create index if not exists idx_tenant_bus_allocations_service on public.tenant_bus_allocations (tenant_id, service_id);
create index if not exists idx_vehicle_anomalies_vehicle_active on public.vehicle_anomalies (tenant_id, vehicle_id, active, reported_at desc);
create index if not exists idx_quotes_tenant_created_at on public.quotes (tenant_id, created_at desc);
create index if not exists idx_quote_waypoints_quote on public.quote_waypoints (quote_id, sort_order);
create index if not exists idx_tenant_user_feature_flags on public.tenant_user_feature_flags (tenant_id, feature_code, enabled);

alter table public.tenant_bus_lines enable row level security;
alter table public.tenant_bus_line_stops enable row level security;
alter table public.tenant_bus_units enable row level security;
alter table public.tenant_bus_allocations enable row level security;
alter table public.tenant_bus_allocation_moves enable row level security;
alter table public.vehicle_anomalies enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_waypoints enable row level security;
alter table public.tenant_user_feature_flags enable row level security;

drop policy if exists tenant_bus_lines_tenant_all on public.tenant_bus_lines;
create policy tenant_bus_lines_tenant_all on public.tenant_bus_lines
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists tenant_bus_line_stops_tenant_all on public.tenant_bus_line_stops;
create policy tenant_bus_line_stops_tenant_all on public.tenant_bus_line_stops
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists tenant_bus_units_tenant_all on public.tenant_bus_units;
create policy tenant_bus_units_tenant_all on public.tenant_bus_units
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists tenant_bus_allocations_tenant_all on public.tenant_bus_allocations;
create policy tenant_bus_allocations_tenant_all on public.tenant_bus_allocations
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists tenant_bus_allocation_moves_tenant_all on public.tenant_bus_allocation_moves;
create policy tenant_bus_allocation_moves_tenant_all on public.tenant_bus_allocation_moves
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists vehicle_anomalies_tenant_select on public.vehicle_anomalies;
drop policy if exists vehicle_anomalies_admin_operator_insert on public.vehicle_anomalies;
drop policy if exists vehicle_anomalies_admin_operator_update on public.vehicle_anomalies;
drop policy if exists vehicle_anomalies_driver_insert on public.vehicle_anomalies;

create policy vehicle_anomalies_tenant_select on public.vehicle_anomalies
for select
using (tenant_id = public.current_tenant_id());

create policy vehicle_anomalies_admin_operator_insert on public.vehicle_anomalies
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy vehicle_anomalies_driver_insert on public.vehicle_anomalies
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and driver_user_id = auth.uid()
);

create policy vehicle_anomalies_admin_operator_update on public.vehicle_anomalies
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists quotes_tenant_all on public.quotes;
create policy quotes_tenant_all on public.quotes
for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists quote_waypoints_tenant_all on public.quote_waypoints;
create policy quote_waypoints_tenant_all on public.quote_waypoints
for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists tenant_user_feature_flags_tenant_all on public.tenant_user_feature_flags;
create policy tenant_user_feature_flags_tenant_all on public.tenant_user_feature_flags
for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);
