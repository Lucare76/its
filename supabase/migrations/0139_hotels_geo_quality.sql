do $$
begin
  if not exists (select 1 from pg_type where typname = 'hotel_geo_status') then
    create type public.hotel_geo_status as enum ('missing', 'generic', 'approximate', 'verified');
  end if;

  if not exists (select 1 from pg_type where typname = 'hotel_geo_source') then
    create type public.hotel_geo_source as enum ('manual', 'google', 'nominatim', 'import', 'unknown');
  end if;

  if not exists (select 1 from pg_type where typname = 'hotel_geo_accuracy') then
    create type public.hotel_geo_accuracy as enum ('unknown', 'area', 'street', 'rooftop');
  end if;
end $$;

alter table public.hotels
  alter column lat drop not null,
  alter column lng drop not null;

alter table public.hotels
  add column if not exists geo_status public.hotel_geo_status not null default 'missing',
  add column if not exists geo_source public.hotel_geo_source not null default 'unknown',
  add column if not exists geo_accuracy public.hotel_geo_accuracy not null default 'unknown',
  add column if not exists geo_verified_at timestamptz null,
  add column if not exists geo_verified_by text null,
  add column if not exists geo_notes text null,
  add column if not exists place_id text null,
  add column if not exists formatted_address text null;

update public.hotels
set
  geo_source = case
    when source = 'manual' then 'manual'::public.hotel_geo_source
    when source in ('osm_overpass', 'import') then 'import'::public.hotel_geo_source
    else coalesce(geo_source, 'unknown'::public.hotel_geo_source)
  end,
  geo_accuracy = case
    when lat is null or lng is null or (abs(lat) < 0.000001 and abs(lng) < 0.000001) then 'unknown'::public.hotel_geo_accuracy
    when address is null or length(trim(address)) < 6 or lower(trim(address)) = 'ischia' then 'area'::public.hotel_geo_accuracy
    else 'street'::public.hotel_geo_accuracy
  end,
  geo_status = case
    when lat is null or lng is null or (abs(lat) < 0.000001 and abs(lng) < 0.000001) then 'missing'::public.hotel_geo_status
    when lat < 40.67 or lat > 40.77 or lng < 13.82 or lng > 13.99 then 'generic'::public.hotel_geo_status
    when address is null or length(trim(address)) < 6 or lower(trim(address)) = 'ischia' then 'generic'::public.hotel_geo_status
    when
      abs(lat - 40.7405) < 0.0012 and abs(lng - 13.9438) < 0.0012 or
      abs(lat - 40.7342) < 0.0012 and abs(lng - 13.9589) < 0.0012 or
      abs(lat - 40.7478) < 0.0012 and abs(lng - 13.9099) < 0.0012 or
      abs(lat - 40.7513) < 0.0012 and abs(lng - 13.8892) < 0.0012 or
      abs(lat - 40.7369) < 0.0012 and abs(lng - 13.8584) < 0.0012 or
      abs(lat - 40.7144) < 0.0012 and abs(lng - 13.9466) < 0.0012 or
      abs(lat - 40.6958) < 0.0012 and abs(lng - 13.8984) < 0.0012 or
      abs(lat - 40.7418) < 0.0012 and abs(lng - 13.9426) < 0.0012
      then 'generic'::public.hotel_geo_status
    else 'approximate'::public.hotel_geo_status
  end,
  formatted_address = coalesce(formatted_address, nullif(address, ''))
where geo_verified_at is null;

create index if not exists idx_hotels_geo_status
  on public.hotels (tenant_id, geo_status);

comment on column public.hotels.geo_status is 'Qualita operativa della geolocalizzazione hotel: missing, generic, approximate, verified.';
comment on column public.hotels.geo_source is 'Origine coordinate: manual, google, nominatim, import, unknown.';
comment on column public.hotels.geo_accuracy is 'Precisione stimata: unknown, area, street, rooftop.';
comment on column public.hotels.geo_verified_at is 'Data verifica manuale o affidabile della posizione.';
comment on column public.hotels.geo_verified_by is 'Utente o sistema che ha verificato la posizione.';
comment on column public.hotels.geo_notes is 'Note operative sulla geolocalizzazione.';
comment on column public.hotels.place_id is 'Identificativo esterno del luogo quando disponibile.';
comment on column public.hotels.formatted_address is 'Indirizzo normalizzato restituito da geocoder o validato manualmente.';
