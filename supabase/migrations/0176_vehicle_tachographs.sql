-- Migration 0176: Scadenza cronotachigrafo per veicolo
-- Traccia la calibrazione/verifica del dispositivo cronotachigrafo installato
-- sul mezzo (tariffa biennale), separata dalla carta tachigrafo del driver.

create table if not exists public.vehicle_tachographs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  calibration_date date not null,
  expiry_date      date not null,
  center           text null,       -- centro di taratura
  certificate_number text null,     -- numero certificato
  document_path    text null,
  notes            text null,
  is_current       boolean not null default true,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_vehicle_tachographs_vehicle
  on public.vehicle_tachographs(vehicle_id, expiry_date desc);
create index if not exists idx_vehicle_tachographs_tenant_expiry
  on public.vehicle_tachographs(tenant_id, expiry_date)
  where is_current = true;

alter table public.vehicle_tachographs enable row level security;

create policy vehicle_tachographs_tenant on public.vehicle_tachographs
  for all
  using (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ))
  with check (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ));
