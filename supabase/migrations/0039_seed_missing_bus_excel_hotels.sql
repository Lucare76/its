alter table public.hotels
  add column if not exists normalized_name text null;

with source_hotels (name, address, lat, lng, zone) as (
  values
    ('Hotel President', 'Import Excel bus cliente', 40.7418, 13.9426, 'manual_import'),
    ('Hotel Tirrenia', 'Import Excel bus cliente', 40.7418, 13.9426, 'manual_import'),
    ('Hotel Eden Park', 'Import Excel bus cliente', 40.7418, 13.9426, 'manual_import'),
    ('Hotel Villa Svizzera', 'Import Excel bus cliente', 40.7418, 13.9426, 'manual_import'),
    ('Hotel Punta del Sole', 'Import Excel bus cliente', 40.7418, 13.9426, 'manual_import'),
    ('Hotel Lord Byron', 'Import Excel bus cliente', 40.7418, 13.9426, 'manual_import')
),
prepared_hotels as (
  select
    'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid as tenant_id,
    name,
    address,
    lat,
    lng,
    zone,
    lower(regexp_replace(regexp_replace(name, '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as normalized_name
  from source_hotels
)
insert into public.hotels (
  tenant_id,
  name,
  address,
  lat,
  lng,
  zone,
  normalized_name
)
select
  prepared_hotels.tenant_id,
  prepared_hotels.name,
  prepared_hotels.address,
  prepared_hotels.lat,
  prepared_hotels.lng,
  prepared_hotels.zone,
  prepared_hotels.normalized_name
from prepared_hotels
where not exists (
  select 1
  from public.hotels h
  where h.tenant_id = prepared_hotels.tenant_id
    and lower(regexp_replace(coalesce(h.normalized_name, h.name), '\s+', ' ', 'g')) = prepared_hotels.normalized_name
);

update public.hotels
set normalized_name = lower(regexp_replace(regexp_replace(coalesce(name, ''), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g'))
where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid
  and name in (
    'Hotel President',
    'Hotel Tirrenia',
    'Hotel Eden Park',
    'Hotel Villa Svizzera',
    'Hotel Punta del Sole',
    'Hotel Lord Byron'
  )
  and coalesce(normalized_name, '') = '';
