-- 0189: Place-based import for future services
-- Adds a normalized places catalog and explicit origin/destination references
-- so territorial services are not forced into hotels.

create extension if not exists unaccent with schema public;

create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  normalized_name text not null,
  place_type text not null check (place_type in ('hotel', 'locality', 'poi', 'attraction', 'port', 'airport', 'station')),
  address text null,
  city text null,
  zone text null,
  lat double precision null,
  lng double precision null,
  geo_source text not null default 'manual' check (geo_source in ('manual', 'nominatim', 'osm', 'import', 'unknown')),
  confidence integer not null default 100 check (confidence between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, normalized_name, place_type)
);

create table if not exists public.place_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  alias text not null,
  alias_normalized text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (tenant_id, alias_normalized, place_id)
);

create index if not exists idx_places_tenant_type_name
  on public.places (tenant_id, place_type, normalized_name)
  where active = true;

create index if not exists idx_place_aliases_tenant_alias
  on public.place_aliases (tenant_id, alias_normalized);

alter table public.places enable row level security;
alter table public.place_aliases enable row level security;

drop policy if exists places_tenant_select on public.places;
create policy places_tenant_select on public.places
for select using (tenant_id = public.current_tenant_id());

drop policy if exists places_admin_operator_all on public.places;
create policy places_admin_operator_all on public.places
for all
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'));

drop policy if exists place_aliases_tenant_select on public.place_aliases;
create policy place_aliases_tenant_select on public.place_aliases
for select using (tenant_id = public.current_tenant_id());

drop policy if exists place_aliases_admin_operator_all on public.place_aliases;
create policy place_aliases_admin_operator_all on public.place_aliases
for all
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin','operator'));

alter table public.services
  add column if not exists service_category text null
    check (service_category is null or service_category in ('arrival', 'departure', 'transfer', 'excursion', 'territorial')),
  add column if not exists route_kind text null
    check (route_kind is null or route_kind in (
      'porto_hotel',
      'hotel_porto',
      'aeroporto_hotel',
      'hotel_aeroporto',
      'stazione_hotel',
      'hotel_stazione',
      'hotel_luogo',
      'luogo_hotel',
      'luogo_luogo',
      'hotel_attrazione',
      'attrazione_hotel',
      'escursione',
      'territoriale'
    )),
  add column if not exists origin_place_id uuid null references public.places (id) on delete set null,
  add column if not exists destination_place_id uuid null references public.places (id) on delete set null,
  add column if not exists origin_label_raw text null,
  add column if not exists destination_label_raw text null,
  add column if not exists origin_place_type text null
    check (origin_place_type is null or origin_place_type in ('hotel', 'locality', 'poi', 'attraction', 'port', 'airport', 'station', 'address', 'other')),
  add column if not exists destination_place_type text null
    check (destination_place_type is null or destination_place_type in ('hotel', 'locality', 'poi', 'attraction', 'port', 'airport', 'station', 'address', 'other')),
  add column if not exists geo_status text not null default 'not_applicable'
    check (geo_status in ('not_applicable', 'matched', 'needs_review', 'ambiguous', 'not_found')),
  add column if not exists geo_confidence integer null check (geo_confidence is null or geo_confidence between 0 and 100);

create index if not exists idx_services_place_route
  on public.services (tenant_id, service_category, route_kind, date);

create index if not exists idx_services_origin_destination_places
  on public.services (tenant_id, origin_place_id, destination_place_id)
  where origin_place_id is not null or destination_place_id is not null;

-- Seed hotel places from the existing hotel catalog. No fake coordinates are created:
-- existing hotel coordinates are reused when present.
insert into public.places (
  tenant_id,
  name,
  normalized_name,
  place_type,
  address,
  city,
  zone,
  lat,
  lng,
  geo_source,
  confidence,
  active
)
select
  h.tenant_id,
  h.name,
  btrim(lower(regexp_replace(public.unaccent(coalesce(h.normalized_name, h.name)), '[^a-z0-9]+', ' ', 'g'))),
  'hotel',
  h.address,
  h.city,
  h.zone,
  h.lat,
  h.lng,
  coalesce(h.geo_source::text, 'import'),
  case when h.lat is not null and h.lng is not null then 90 else 50 end,
  coalesce(h.is_active, true)
from public.hotels h
where trim(h.name) <> ''
on conflict (tenant_id, normalized_name, place_type) do nothing;

-- Minimal known places for Ischia Transfer Service tenant.
insert into public.places (
  tenant_id,
  name,
  normalized_name,
  place_type,
  address,
  city,
  zone,
  lat,
  lng,
  geo_source,
  confidence
)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Porto Ischia', 'porto ischia', 'port', 'Porto di Ischia', 'Ischia', 'Ischia Porto', 40.7437, 13.9447, 'manual', 100),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Casamicciola', 'casamicciola', 'port', 'Porto di Casamicciola Terme', 'Casamicciola Terme', 'Casamicciola', 40.7476, 13.9077, 'manual', 100),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Beverello', 'beverello', 'port', 'Molo Beverello', 'Napoli', 'Napoli', 40.8385, 14.2564, 'manual', 100),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Aeroporto Napoli', 'aeroporto napoli', 'airport', 'Aeroporto Internazionale di Napoli', 'Napoli', 'Capodichino', 40.8845, 14.2908, 'manual', 100),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Stazione Napoli Centrale', 'stazione napoli centrale', 'station', 'Piazza Garibaldi', 'Napoli', 'Napoli Centrale', 40.8522, 14.2725, 'manual', 100),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Sant''Angelo', 'sant angelo', 'locality', null, 'Serrara Fontana', 'Sant''Angelo', 40.6966, 13.8941, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Mortella', 'mortella', 'attraction', 'Giardini La Mortella', 'Forio', 'Zaro', 40.7532, 13.8745, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Giardini Ravino', 'giardini ravino', 'attraction', 'Via Provinciale Panza', 'Forio', 'Forio', 40.7252, 13.8547, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Nitrodi', 'nitrodi', 'attraction', 'Fonte delle Ninfe Nitrodi', 'Barano d''Ischia', 'Buonopane', 40.7165, 13.9265, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Procida', 'procida', 'locality', null, 'Procida', 'Procida', 40.7657, 14.0262, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Napoli', 'napoli', 'locality', null, 'Napoli', 'Napoli', 40.8518, 14.2681, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Lacco Ameno', 'lacco ameno', 'locality', null, 'Lacco Ameno', 'Lacco Ameno', 40.7508, 13.8900, 'manual', 95),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'Ischia', 'ischia', 'locality', null, 'Ischia', 'Ischia', 40.7290, 13.9480, 'manual', 95)
on conflict (tenant_id, normalized_name, place_type) do nothing;

insert into public.place_aliases (tenant_id, place_id, alias, alias_normalized, source)
select tenant_id, id, alias, alias_normalized, 'seed'
from (
  select p.tenant_id, p.id, 'Porto di Ischia' as alias, 'porto di ischia' as alias_normalized from public.places p where p.normalized_name = 'porto ischia'
  union all
  select p.tenant_id, p.id, 'Porto Casamicciola', 'porto casamicciola' from public.places p where p.normalized_name = 'casamicciola'
  union all
  select p.tenant_id, p.id, 'Napoli Beverello', 'napoli beverello' from public.places p where p.normalized_name = 'beverello'
  union all
  select p.tenant_id, p.id, 'Capodichino', 'capodichino' from public.places p where p.normalized_name = 'aeroporto napoli'
  union all
  select p.tenant_id, p.id, 'Napoli Centrale', 'napoli centrale' from public.places p where p.normalized_name = 'stazione napoli centrale'
  union all
  select p.tenant_id, p.id, 'La Mortella', 'la mortella' from public.places p where p.normalized_name = 'mortella'
) aliases
on conflict (tenant_id, alias_normalized, place_id) do nothing;
