-- ============================================================
-- FASE 1 — Modello GRUPPI PRENOTAZIONE (contenitore commerciale stabile).
--
-- Distinto e NON collegato a:
--   * trip_groups           — giro operativo Piano del Giorno (driver+mezzo+data)
--   * assignments.group_id  — FK verso trip_groups
--   * tenant_bus_units      — mezzo persistente per linea (NON date-scoped)
--   * bus_line_ferry_config — default traghetto per famiglia linea (invariato)
--
-- Un booking_group deve poter esistere PRIMA dei services, senza fermate,
-- senza nominativi, senza nave, senza hotel. Nessuna riga placeholder viene
-- creata in tenant_bus_allocations (service_id resta NOT NULL).
--
-- Nomenclatura esplicita per evitare collisioni: booking_groups /
-- booking_group_stops / booking_group_bus_reservations / services.booking_group_id.
-- ============================================================

-- 1. booking_groups ----------------------------------------------------------
create table if not exists public.booking_groups (
  id                             uuid primary key default gen_random_uuid(),
  tenant_id                      uuid not null references public.tenants(id) on delete cascade,

  name                           text not null,
  expected_pax                   integer not null check (expected_pax > 0 and expected_pax <= 500),
  kind                           text not null default 'other'
                                   check (kind in ('bus_exclusive', 'bus_group', 'multi_service', 'other')),
  status                         text not null default 'draft'
                                   check (status in ('draft', 'to_complete', 'stops_defined', 'passengers_defined', 'operational', 'cancelled')),
  service_date                   date null,
  contact_name                   text null,
  contact_phone                  text null,
  agency_id                      uuid null references public.agencies(id) on delete set null,
  hotel_id                       uuid null references public.hotels(id) on delete set null,
  notes                          text null,

  -- Override traghetto ANDATA verso Ischia.
  -- NULL = eredita il default della linea (bus_line_ferry_config) ove disponibile.
  -- Valore presente = override specifico del gruppo. In FASE 1 NON viene
  -- propagato automaticamente sui services.
  outbound_ferry_company         text null,
  outbound_departure_port        text null,
  outbound_ferry_time            time null,
  outbound_arrival_port          text null,
  outbound_expected_arrival_time time null,

  -- Override traghetto RITORNO da Ischia (stessa semantica NULL = eredita).
  return_ferry_company           text null,
  return_departure_port          text null,
  return_ferry_time              time null,
  return_arrival_port            text null,
  return_expected_arrival_time   time null,

  created_by_user_id             uuid null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

create index if not exists idx_booking_groups_tenant
  on public.booking_groups (tenant_id, created_at desc);
create index if not exists idx_booking_groups_tenant_date
  on public.booking_groups (tenant_id, service_date);
create index if not exists idx_booking_groups_tenant_status
  on public.booking_groups (tenant_id, status);

alter table public.booking_groups enable row level security;

drop policy if exists booking_groups_select_admin_operator on public.booking_groups;
create policy booking_groups_select_admin_operator on public.booking_groups
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

drop policy if exists booking_groups_write_admin_operator on public.booking_groups;
create policy booking_groups_write_admin_operator on public.booking_groups
  for all
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  );

-- 2. booking_group_stops ---------------------------------------------------
-- PIANO delle fermate/punti di carico PRIMA della creazione dei services.
-- NON e' un'allocazione operativa: tenant_bus_allocations resta l'esecuzione
-- reale (con service_id NOT NULL) dopo che i nominativi esistono.
create table if not exists public.booking_group_stops (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  booking_group_id uuid not null references public.booking_groups(id) on delete cascade,

  city             text not null,          -- es. "Tivoli"
  pickup_point     text null,              -- es. "Villa d'Este" — MAI concatenato con city
  expected_pax     integer not null check (expected_pax > 0 and expected_pax <= 500),
  stop_id          uuid null references public.tenant_bus_line_stops(id) on delete set null,
  direction        text not null check (direction in ('arrival', 'departure')),
  sort_order       integer not null default 0,
  notes            text null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_booking_group_stops_group
  on public.booking_group_stops (booking_group_id, direction, sort_order);
create index if not exists idx_booking_group_stops_tenant
  on public.booking_group_stops (tenant_id);

alter table public.booking_group_stops enable row level security;

drop policy if exists booking_group_stops_select_admin_operator on public.booking_group_stops;
create policy booking_group_stops_select_admin_operator on public.booking_group_stops
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

drop policy if exists booking_group_stops_write_admin_operator on public.booking_group_stops;
create policy booking_group_stops_write_admin_operator on public.booking_group_stops
  for all
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  );

-- 3. booking_group_bus_reservations -------------------------------------
-- Rende l'esclusiva / capacita' riservata DATE-SCOPED. La fonte di verita'
-- dell'esclusiva per una data e' QUESTA tabella, NON tenant_bus_units.tag
-- (che resta persistente e invariato in FASE 1). tenant_bus_units continua
-- ad essere il mezzo/template riutilizzato ogni domenica.
create table if not exists public.booking_group_bus_reservations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  booking_group_id uuid not null references public.booking_groups(id) on delete cascade,
  bus_unit_id      uuid not null references public.tenant_bus_units(id) on delete cascade,
  service_date     date not null,
  reserved_pax     integer not null check (reserved_pax > 0 and reserved_pax <= 500),
  exclusive        boolean not null default false,
  notes            text null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Evita doppia riserva dello stesso gruppo sullo stesso bus nella stessa data.
  unique (tenant_id, booking_group_id, bus_unit_id, service_date)
);

create index if not exists idx_bgbr_tenant_date_unit
  on public.booking_group_bus_reservations (tenant_id, service_date, bus_unit_id);
create index if not exists idx_bgbr_group
  on public.booking_group_bus_reservations (booking_group_id);

alter table public.booking_group_bus_reservations enable row level security;

drop policy if exists bgbr_select_admin_operator on public.booking_group_bus_reservations;
create policy bgbr_select_admin_operator on public.booking_group_bus_reservations
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

drop policy if exists bgbr_write_admin_operator on public.booking_group_bus_reservations;
create policy bgbr_write_admin_operator on public.booking_group_bus_reservations
  for all
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  );

-- 4. services.booking_group_id ----------------------------------------
-- FK NULLABLE verso il gruppo commerciale. Concetto diverso da
-- linked_service_id (2 gambe A/R), import_id (batch), assignments.group_id
-- (trip_groups). ON DELETE SET NULL: eliminare un booking_group NON cancella
-- i services operativi collegati.
alter table public.services
  add column if not exists booking_group_id uuid null
    references public.booking_groups(id) on delete set null;

create index if not exists idx_services_tenant_booking_group
  on public.services (tenant_id, booking_group_id)
  where booking_group_id is not null;

comment on column public.services.booking_group_id is
  'FASE 1 gruppi prenotazione: FK nullable verso booking_groups. Distinto da linked_service_id / import_id / assignments.group_id.';
