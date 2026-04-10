-- Migration 0115: autisti linea bus per singola data
-- I campi driver_name_outbound/return su tenant_bus_units erano persistenti su tutti i giorni.
-- Questa tabella salva l'assegnazione autista per unit + data, azzerandosi ad ogni nuova giornata.

create table if not exists public.bus_unit_driver_dates (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete cascade,
  unit_id               uuid not null references public.tenant_bus_units (id) on delete cascade,
  travel_date           date not null,
  driver_name_outbound  text null,
  driver_phone_outbound text null,
  driver_name_return    text null,
  driver_phone_return   text null,
  updated_at            timestamptz not null default now(),
  unique (tenant_id, unit_id, travel_date)
);

alter table public.bus_unit_driver_dates enable row level security;

create policy "tenant_isolation" on public.bus_unit_driver_dates
  using (tenant_id = (select memberships.tenant_id from public.memberships where memberships.user_id = auth.uid() limit 1));
