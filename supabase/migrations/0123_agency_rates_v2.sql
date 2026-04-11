-- Migration 0123: agency_rates v2
-- Aggiunge costo operatore, storico prezzi (valid_from), voci custom

-- 1. Aggiungi colonne a agency_rates
alter table public.agency_rates
  add column if not exists cost_cents     integer null check (cost_cents is null or cost_cents >= 0),
  add column if not exists valid_from     date not null default current_date,
  add column if not exists valid_to       date null,
  add column if not exists line_code      text null; -- per bus: codice linea (LINEA_1_ITALIA ecc.)

-- 2. Crea tabella voci custom (service kind extra oltre a quelli hardcoded)
create table if not exists public.agency_rate_kinds (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind_key    text not null,  -- chiave univoca es. "noleggio_pulmino"
  label       text not null,  -- nome visualizzato es. "Noleggio pulmino"
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint agency_rate_kinds_key_not_blank check (length(trim(kind_key)) > 0),
  constraint agency_rate_kinds_tenant_key unique (tenant_id, kind_key)
);

alter table public.agency_rate_kinds enable row level security;

drop policy if exists "agency_rate_kinds_admin_all" on public.agency_rate_kinds;
create policy "agency_rate_kinds_admin_all" on public.agency_rate_kinds
  for all
  using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.tenant_id = agency_rate_kinds.tenant_id
        and m.role in ('admin', 'operator')
    )
  );

-- 3. Indice per lookup storico prezzi
create index if not exists idx_agency_rates_history
  on public.agency_rates (tenant_id, agency_id, booking_service_kind, valid_from desc);
