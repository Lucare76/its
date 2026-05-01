-- Migration 0171: Medmar Flotta Veicoli
-- Modulo SEPARATO da medmar_ar (biglietti passeggeri).
-- Gestisce biglietti per veicoli (taxi/bus/camion) tariffati a METRI LINEARI.

-- ── 1. Lunghezza mezzo in vehicles ────────────────────────────────────────

alter table public.vehicles
  add column if not exists length_meters numeric(5, 2) null;

comment on column public.vehicles.length_meters is 'Lunghezza mezzo in metri lineari (usata per tariffazione Medmar Flotta)';

-- ── 2. Prezzario Medmar Flotta ─────────────────────────────────────────────
-- Storicizzato: mai sovrascrivere, nuovo record con valid_from/valid_to.

create table if not exists public.medmar_fleet_prices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  vehicle_type   text not null,      -- taxi | bus | camion
  meters_from    numeric(5,2) not null,
  meters_to      numeric(5,2) not null,
  route          text not null,      -- pozzuoli_ischia | pozzuoli_casamicciola | napoli_ischia | napoli_casamicciola
  price_ar_cents int  not null,      -- prezzo A/R in centesimi
  price_single_cents int not null,   -- prezzo singola tratta in centesimi
  notes          text null,          -- istruzioni operative per l'ufficio
  valid_from     date not null default current_date,
  valid_to       date null,          -- null = tariffa attuale
  created_at     timestamptz not null default now(),
  created_by     uuid null references auth.users(id) on delete set null,
  constraint medmar_fleet_prices_vehicle_type_check
    check (vehicle_type in ('taxi', 'bus', 'camion')),
  constraint medmar_fleet_prices_route_check
    check (route in ('pozzuoli_ischia', 'pozzuoli_casamicciola', 'napoli_ischia', 'napoli_casamicciola')),
  constraint medmar_fleet_prices_meters_check
    check (meters_from >= 0 and meters_to > meters_from)
);

create index if not exists idx_medmar_fleet_prices_lookup
  on public.medmar_fleet_prices(tenant_id, vehicle_type, route, valid_from)
  where valid_to is null;

alter table public.medmar_fleet_prices enable row level security;

create policy "medmar_fleet_prices_read" on public.medmar_fleet_prices
  for select using (
    tenant_id = (select tenant_id from public.memberships where user_id = auth.uid() limit 1)
  );

create policy "medmar_fleet_prices_admin_write" on public.medmar_fleet_prices
  for all using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and tenant_id = medmar_fleet_prices.tenant_id
        and role in ('admin', 'supervisor')
    )
  );

-- ── 3. Biglietti Medmar Flotta ─────────────────────────────────────────────

create table if not exists public.medmar_fleet_tickets (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  voucher_number      text not null,
  travel_date         date not null,
  vehicle_id          uuid null references public.vehicles(id) on delete set null,
  vehicle_type        text not null,    -- taxi | bus | camion
  plate               text not null,    -- targa al momento dell'emissione
  length_meters       numeric(5,2) not null,
  route               text not null,
  ticket_mode         text not null,    -- round_trip | single
  outbound_time       time null,
  return_time         time null,
  price_cents         int  not null,
  price_id            uuid null references public.medmar_fleet_prices(id) on delete set null,
  status              text not null default 'active',
  -- stati ritorno A/R
  outbound_used       boolean not null default false,
  return_used         boolean not null default false,
  return_reassigned_to_ticket_id uuid null references public.medmar_fleet_tickets(id) on delete set null,
  notes               text null,
  created_at          timestamptz not null default now(),
  created_by          uuid null references auth.users(id) on delete set null,
  constraint medmar_fleet_tickets_vehicle_type_check
    check (vehicle_type in ('taxi', 'bus', 'camion')),
  constraint medmar_fleet_tickets_route_check
    check (route in ('pozzuoli_ischia', 'pozzuoli_casamicciola', 'napoli_ischia', 'napoli_casamicciola')),
  constraint medmar_fleet_tickets_mode_check
    check (ticket_mode in ('round_trip', 'single')),
  constraint medmar_fleet_tickets_status_check
    check (status in ('active', 'used', 'expired', 'cancelled'))
);

create index if not exists idx_medmar_fleet_tickets_date
  on public.medmar_fleet_tickets(tenant_id, travel_date);
create index if not exists idx_medmar_fleet_tickets_plate
  on public.medmar_fleet_tickets(tenant_id, plate);

alter table public.medmar_fleet_tickets enable row level security;

create policy "medmar_fleet_tickets_read" on public.medmar_fleet_tickets
  for select using (
    tenant_id = (select tenant_id from public.memberships where user_id = auth.uid() limit 1)
  );

create policy "medmar_fleet_tickets_write" on public.medmar_fleet_tickets
  for all using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and tenant_id = medmar_fleet_tickets.tenant_id
        and role in ('admin', 'supervisor', 'operator')
    )
  );

-- ── 4. Log cambio targa ────────────────────────────────────────────────────

create table if not exists public.medmar_fleet_plate_changes (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  ticket_id          uuid not null references public.medmar_fleet_tickets(id) on delete cascade,
  original_plate     text not null,
  original_meters    numeric(5,2) not null,
  new_plate          text not null,
  new_meters         numeric(5,2) not null,
  new_vehicle_id     uuid null references public.vehicles(id) on delete set null,
  credit_cents       int  not null default 0,  -- eventuale credito se nuovo mezzo più piccolo
  changed_at         timestamptz not null default now(),
  changed_by         uuid null references auth.users(id) on delete set null,
  notes              text null
);

alter table public.medmar_fleet_plate_changes enable row level security;

create policy "medmar_fleet_plate_changes_read" on public.medmar_fleet_plate_changes
  for select using (
    tenant_id = (select tenant_id from public.memberships where user_id = auth.uid() limit 1)
  );

create policy "medmar_fleet_plate_changes_write" on public.medmar_fleet_plate_changes
  for all using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and tenant_id = medmar_fleet_plate_changes.tenant_id
        and role in ('admin', 'supervisor', 'operator')
    )
  );
