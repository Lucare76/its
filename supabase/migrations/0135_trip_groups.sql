-- Piano del Giorno: tabella giri (trip_groups).
-- Ogni giro raggruppa più servizi assegnati allo stesso autista e mezzo nello stesso slot.
-- assignments già esistenti rimangono validi (group_id nullable).

create table if not exists public.trip_groups (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null,
  date             date        not null,
  driver_user_id   uuid,
  vehicle_label    text,
  vehicle_capacity int,
  notes            text,
  status           text        not null default 'active'
                     check (status in ('active', 'cancelled')),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists trip_groups_tenant_date
  on public.trip_groups (tenant_id, date);
create index if not exists trip_groups_driver
  on public.trip_groups (driver_user_id, date);

alter table public.trip_groups enable row level security;
create policy "tenant_read"  on public.trip_groups for select using (true);
create policy "tenant_write" on public.trip_groups for all using (true);

-- Collega assignments ai giri (nullable: gli assignment vecchi rimangono invariati)
alter table public.assignments
  add column if not exists group_id uuid references public.trip_groups(id) on delete set null;

create index if not exists assignments_group_id
  on public.assignments (group_id);
