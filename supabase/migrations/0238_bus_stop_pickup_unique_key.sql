-- Migration: allow the same bus stop/city name to have multiple pickup points.
--
-- Before this change tenant_bus_line_stops was unique by:
--   bus_line_id + direction + stop_name
-- That prevented valid operational cases such as:
--   ROMA / Area di Servizio Prenestina Ovest
--   ROMA / SAN CAMILLO
-- on the same line and direction.
--
-- Keep ROMA TIBURTINA / ROMA ANAGNINA as distinct stop names, but allow any
-- stop name to be repeated when the pickup point is different.

alter table public.tenant_bus_line_stops
  add column if not exists pickup_note_key text
  generated always as (coalesce(nullif(btrim(pickup_note), ''), '__no_pickup_note__')) stored;

alter table public.tenant_bus_line_stops
  drop constraint if exists tenant_bus_line_stops_bus_line_id_direction_stop_name_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_bus_line_stops_line_direction_name_pickup_key'
      and conrelid = 'public.tenant_bus_line_stops'::regclass
  ) then
    alter table public.tenant_bus_line_stops
      add constraint tenant_bus_line_stops_line_direction_name_pickup_key
      unique (bus_line_id, direction, stop_name, pickup_note_key);
  end if;
end $$;

create index if not exists idx_tenant_bus_line_stops_name_pickup
  on public.tenant_bus_line_stops (bus_line_id, direction, stop_name, pickup_note_key);
