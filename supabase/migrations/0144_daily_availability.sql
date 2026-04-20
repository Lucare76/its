-- Dichiarazione disponibilità giornaliera di autisti e mezzi.
-- L'operatore la compila il giorno prima. Solo dopo la conferma il Piano del Giorno
-- è operativo per l'assegnazione automatica.

-- ─── Disponibilità autisti ────────────────────────────────────────────────────
create table if not exists public.driver_daily_availability (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  driver_user_id  uuid not null references auth.users (id) on delete cascade,
  date            date not null,
  available       boolean not null default true,
  available_from  time null,         -- null = intera giornata
  available_to    time null,
  notes           text null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, driver_user_id, date)
);

-- ─── Disponibilità + blocchi mezzi ────────────────────────────────────────────
create table if not exists public.vehicle_daily_availability (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  date        date not null,
  available   boolean not null default true,
  notes       text null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, vehicle_id, date)
);

-- ─── Blocchi orari mezzo (escursioni, manutenzioni, rientro porto, fuori servizio) ──
create table if not exists public.vehicle_time_blocks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  date        date not null,
  block_from  time not null,
  block_to    time not null,
  reason      text not null check (reason in (
    'escursione', 'manutenzione', 'fuori_servizio',
    'rientro_porto_ischia', 'rientro_porto_casamicciola', 'altro'
  )),
  reason_notes text null,
  created_at  timestamptz not null default now(),
  check (block_to > block_from)
);

-- ─── Conferma disponibilità giornaliera ───────────────────────────────────────
create table if not exists public.daily_availability_confirmations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  date        date not null,
  confirmed   boolean not null default false,
  confirmed_at timestamptz null,
  confirmed_by uuid null references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, date)
);

-- ─── Indici ───────────────────────────────────────────────────────────────────
create index if not exists driver_daily_avail_date_idx   on public.driver_daily_availability (tenant_id, date);
create index if not exists vehicle_daily_avail_date_idx  on public.vehicle_daily_availability (tenant_id, date);
create index if not exists vehicle_time_blocks_date_idx  on public.vehicle_time_blocks (tenant_id, date, vehicle_id);
create index if not exists daily_avail_confirm_date_idx  on public.daily_availability_confirmations (tenant_id, date);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
alter table public.driver_daily_availability       enable row level security;
alter table public.vehicle_daily_availability      enable row level security;
alter table public.vehicle_time_blocks             enable row level security;
alter table public.daily_availability_confirmations enable row level security;

create policy "driver_avail_tenant_rw" on public.driver_daily_availability for all
  using (exists (select 1 from public.memberships where user_id = auth.uid() and tenant_id = driver_daily_availability.tenant_id and role in ('admin','operator','supervisor','driver')));

create policy "vehicle_avail_tenant_rw" on public.vehicle_daily_availability for all
  using (exists (select 1 from public.memberships where user_id = auth.uid() and tenant_id = vehicle_daily_availability.tenant_id and role in ('admin','operator','supervisor')));

create policy "vehicle_blocks_tenant_rw" on public.vehicle_time_blocks for all
  using (exists (select 1 from public.memberships where user_id = auth.uid() and tenant_id = vehicle_time_blocks.tenant_id and role in ('admin','operator','supervisor')));

create policy "daily_confirm_tenant_rw" on public.daily_availability_confirmations for all
  using (exists (select 1 from public.memberships where user_id = auth.uid() and tenant_id = daily_availability_confirmations.tenant_id and role in ('admin','operator','supervisor')));
