-- Migration 0086: place_type su services + email Bruno in settings
-- place_type distingue i servizi hotel (default) da quelli stazione/aeroporto
-- che devono essere inclusi nelle Liste Bruno gestite da Karmen Peach.

-- ── place_type su services ────────────────────────────────────────────────────
alter table public.services
  add column if not exists place_type text not null default 'hotel'
    check (place_type in ('hotel', 'station', 'airport'));

comment on column public.services.place_type is
  'Tipo di luogo pickup/dropoff. hotel = normale, station = stazione ferroviaria, airport = aeroporto. I servizi station/airport appaiono nelle Liste Bruno.';

create index if not exists idx_services_place_type
  on public.services (tenant_id, place_type)
  where place_type <> 'hotel';

-- ── Email Bruno in tenant_operational_settings ────────────────────────────────
alter table public.tenant_operational_settings
  add column if not exists bruno_email text null;

comment on column public.tenant_operational_settings.bruno_email is
  'Email di Bruno: destinatario delle Liste Bruno inviate da Karmen Peach.';
