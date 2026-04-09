-- Vehicle QR tokens + manutenzioni + rifornimenti + ricambi
-- 0100_vehicle_qr_and_records.sql

-- 1. Aggiungi qr_token ai veicoli
alter table public.vehicles
  add column if not exists qr_token text unique;

-- Genera token per i veicoli esistenti
update public.vehicles
  set qr_token = replace(gen_random_uuid()::text, '-', '')
  where qr_token is null;

-- 2. Tabella manutenzioni
create table if not exists public.vehicle_maintenance (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  maintenance_date date not null,
  description   text not null,
  cost          numeric(10,2) null,
  km_at_service integer null,
  provider      text null,
  notes         text null,
  created_by    uuid null,
  created_at    timestamptz not null default now()
);

alter table public.vehicle_maintenance enable row level security;

drop policy if exists "tenant_isolation_vehicle_maintenance" on public.vehicle_maintenance;
create policy "tenant_isolation_vehicle_maintenance"
  on public.vehicle_maintenance for all
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid()
    )
  );

-- 3. Tabella rifornimenti carburante
create table if not exists public.vehicle_fuel (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  fuel_date     date not null,
  liters        numeric(8,2) null,
  cost          numeric(10,2) null,
  km_at_fuel    integer null,
  fuel_type     text null,  -- diesel, benzina, gas, elettrico
  station       text null,
  notes         text null,
  created_by    uuid null,
  created_at    timestamptz not null default now()
);

alter table public.vehicle_fuel enable row level security;

drop policy if exists "tenant_isolation_vehicle_fuel" on public.vehicle_fuel;
create policy "tenant_isolation_vehicle_fuel"
  on public.vehicle_fuel for all
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid()
    )
  );

-- 4. Tabella ricambi ordinati
create table if not exists public.vehicle_spare_parts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  order_date    date not null,
  part_name     text not null,
  quantity      integer not null default 1,
  cost          numeric(10,2) null,
  supplier      text null,
  status        text not null default 'ordered',  -- ordered, received, installed
  installed_at  date null,
  notes         text null,
  created_by    uuid null,
  created_at    timestamptz not null default now()
);

alter table public.vehicle_spare_parts enable row level security;

drop policy if exists "tenant_isolation_vehicle_spare_parts" on public.vehicle_spare_parts;
create policy "tenant_isolation_vehicle_spare_parts"
  on public.vehicle_spare_parts for all
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid()
    )
  );

-- 5. Segnalazioni danno via QR (pubblico - no auth richiesta)
create table if not exists public.vehicle_qr_reports (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  reporter_name text null,
  description   text not null,
  severity      text not null default 'low',  -- low / medium / high / blocking
  photo_urls    text[] null,
  status        text not null default 'open',  -- open / acknowledged / resolved
  created_at    timestamptz not null default now()
);

alter table public.vehicle_qr_reports enable row level security;

-- Chiunque può inserire (link QR pubblico)
drop policy if exists "public_insert_vehicle_qr_reports" on public.vehicle_qr_reports;
create policy "public_insert_vehicle_qr_reports"
  on public.vehicle_qr_reports for insert
  with check (true);

-- Solo i membri del tenant possono leggere
drop policy if exists "tenant_read_vehicle_qr_reports" on public.vehicle_qr_reports;
create policy "tenant_read_vehicle_qr_reports"
  on public.vehicle_qr_reports for select
  using (
    vehicle_id in (
      select v.id from public.vehicles v
      join public.memberships m on m.tenant_id = v.tenant_id
      where m.user_id = auth.uid()
    )
  );

-- Indici
create index if not exists idx_vehicle_maintenance_vehicle on public.vehicle_maintenance(vehicle_id);
create index if not exists idx_vehicle_fuel_vehicle on public.vehicle_fuel(vehicle_id);
create index if not exists idx_vehicle_spare_parts_vehicle on public.vehicle_spare_parts(vehicle_id);
create index if not exists idx_vehicle_qr_reports_vehicle on public.vehicle_qr_reports(vehicle_id);
create index if not exists idx_vehicles_qr_token on public.vehicles(qr_token);
