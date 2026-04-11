-- Migration: Listini agenzia per tipo servizio + prezzo dichiarato sulla prenotazione

-- 1) Tabella listino prezzi per agenzia
create table if not exists public.agency_rates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  agency_id     uuid null references public.agencies (id) on delete cascade,   -- NULL = default tutte le agenzie
  hotel_id      uuid null references public.hotels (id) on delete cascade,     -- NULL = tutti gli hotel
  booking_service_kind text not null,
  price_cents   integer not null check (price_cents >= 0),
  notes         text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint agency_rates_kind_not_blank check (length(trim(booking_service_kind)) > 0)
);

create index if not exists idx_agency_rates_lookup
  on public.agency_rates (tenant_id, active, booking_service_kind, agency_id, hotel_id);

-- RLS
alter table public.agency_rates enable row level security;

drop policy if exists "agency_rates_admin_all"   on public.agency_rates;
drop policy if exists "agency_rates_agency_read"  on public.agency_rates;

create policy "agency_rates_admin_all" on public.agency_rates
  for all
  using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.tenant_id = agency_rates.tenant_id
        and m.role in ('admin', 'operator')
    )
  );

create policy "agency_rates_agency_read" on public.agency_rates
  for select
  using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.tenant_id = agency_rates.tenant_id
        and m.role = 'agency'
    )
  );

-- 2) Prezzo dichiarato dall'agenzia sulla prenotazione
alter table public.services
  add column if not exists agency_quoted_price_cents integer null
  check (agency_quoted_price_cents is null or agency_quoted_price_cents >= 0);
