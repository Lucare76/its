-- 1. Passeggeri importati da validare (fermata non trovata)
create table if not exists public.bus_import_pending (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  bus_line_id uuid not null references public.tenant_bus_lines(id) on delete cascade,
  direction text not null check (direction in ('arrival', 'departure')),
  travel_date date not null,
  passenger_name text not null,
  passenger_phone text,
  passenger_email text,
  city_original text not null,
  pax integer not null default 1 check (pax > 0),
  notes text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  geo_lat double precision,
  geo_lng double precision,
  geo_suggested_stop text,
  created_at timestamptz not null default now()
);

alter table public.bus_import_pending enable row level security;

create policy "bus_import_pending_tenant_rls" on public.bus_import_pending
  using (tenant_id in (select tenant_id from public.memberships where user_id = auth.uid()));

-- 2. Autisti per rete ischia
create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  phone text,
  vehicle_type text,
  capacity integer not null default 8,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.drivers enable row level security;

create policy "drivers_tenant_rls" on public.drivers
  using (tenant_id in (select tenant_id from public.memberships where user_id = auth.uid()));

-- 3. Servizi ischia (hotel → hotel)
create table if not exists public.services_ischia (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_name text not null,
  customer_phone text,
  hotel_partenza_id uuid references public.hotels(id),
  hotel_arrivo_id uuid references public.hotels(id),
  hotel_partenza_name text not null,
  hotel_arrivo_name text not null,
  travel_date date not null,
  orario time,
  pax integer not null default 1 check (pax > 0),
  driver_id uuid references public.drivers(id),
  status text not null default 'pending' check (status in ('pending', 'assigned', 'completed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.services_ischia enable row level security;

create policy "services_ischia_tenant_rls" on public.services_ischia
  using (tenant_id in (select tenant_id from public.memberships where user_id = auth.uid()));
