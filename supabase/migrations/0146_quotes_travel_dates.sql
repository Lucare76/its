-- Adds travel dates to customer quotes.
alter table public.quotes
  add column if not exists arrival_date date null,
  add column if not exists departure_date date null,
  add column if not exists quote_service_code text null,
  add column if not exists quote_bus_line_id uuid null references public.tenant_bus_lines (id) on delete set null;

alter table public.quote_waypoints
  add column if not exists waypoint_type text not null default 'pickup'
  check (waypoint_type in ('pickup', 'dropoff'));

alter table public.services
  add column if not exists source_quote_id uuid null references public.quotes (id) on delete set null,
  add column if not exists source_quote_leg text null check (source_quote_leg is null or source_quote_leg in ('arrival', 'departure'));

create unique index if not exists idx_services_source_quote_leg
  on public.services (tenant_id, source_quote_id, source_quote_leg)
  where source_quote_id is not null and source_quote_leg is not null;
