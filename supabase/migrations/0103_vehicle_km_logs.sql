-- Log chilometri per turno autista (registrati via QR)
create table if not exists public.vehicle_km_logs (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  driver_name  text not null,
  start_km     integer not null,
  end_km       integer null,       -- null finché non chiude il turno
  start_at     timestamptz not null default now(),
  end_at       timestamptz null,
  notes        text null,
  created_at   timestamptz not null default now()
);

alter table public.vehicle_km_logs enable row level security;

-- Chiunque può inserire (link QR pubblico)
drop policy if exists "public_insert_vehicle_km_logs" on public.vehicle_km_logs;
create policy "public_insert_vehicle_km_logs"
  on public.vehicle_km_logs for insert
  with check (true);

-- Chiunque può aggiornare (per chiudere il turno con km finale)
drop policy if exists "public_update_vehicle_km_logs" on public.vehicle_km_logs;
create policy "public_update_vehicle_km_logs"
  on public.vehicle_km_logs for update
  using (true);

-- Chiunque può leggere (per mostrare ultimo turno aperto)
drop policy if exists "public_select_vehicle_km_logs" on public.vehicle_km_logs;
create policy "public_select_vehicle_km_logs"
  on public.vehicle_km_logs for select
  using (true);

create index if not exists idx_vehicle_km_logs_vehicle on public.vehicle_km_logs(vehicle_id);
create index if not exists idx_vehicle_km_logs_open on public.vehicle_km_logs(vehicle_id, end_km) where end_km is null;
