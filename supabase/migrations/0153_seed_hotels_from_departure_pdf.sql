-- Seed hotel names extracted from "hotel ed orari partenze.pdf".
-- Goal: make the hotel registry and alias matching aware of departure-rule hotels.

with source_hotels (name) as (
  values
    ('Hotel Saint Raphael'),
    ('Hotel Sorriso'),
    ('Park Hotel Imperial'),
    ('Hotel Baia delle Sirene'),
    ('Hotel Tramonto d''Oro'),
    ('Hotel Villa Franca'),
    ('Hotel Villa al Parco'),
    ('Park Hotel La Villa'),
    ('Hotel Parco dei Principi'),
    ('Hotel Carlo Magno'),
    ('Hotel Don Pepe'),
    ('Hotel Cristallo'),
    ('Hotel Gran Paradiso'),
    ('Hotel Stella Maris'),
    ('Hotel Terme President'),
    ('Grand Hotel delle Terme Re Ferdinando'),
    ('Hotel Aragonese'),
    ('Hotel Terme Felix'),
    ('Hotel Tirrenia'),
    ('Hotel Bristol'),
    ('Isola Verde Hotel & Thermal Spa'),
    ('San Valentino Terme'),
    ('Hotel San Giovanni Terme'),
    ('Hotel Ulisse'),
    ('Central Park Terme'),
    ('Hotel Hermitage'),
    ('Hotel Terme Oriente'),
    ('Hotel Floridiana Terme'),
    ('Hotel Continental Terme'),
    ('Hotel Royal Terme'),
    ('Parco Hotel Terme Villa Teresa'),
    ('Royal Palm Hotel Terme'),
    ('Hotel Zi Carmela'),
    ('Hotel Terme Colella'),
    ('Hotel La Rosa'),
    ('Hotel Punta del Sole'),
    ('Grand Hotel Terme di Augusto')
),
prepared_hotels as (
  select
    'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid as tenant_id,
    name,
    'Import PDF hotel partenze'::text as address,
    'Ischia'::text as city,
    40.7418::double precision as lat,
    13.9426::double precision as lng,
    'manual_import'::text as zone,
    lower(regexp_replace(regexp_replace(name, '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as normalized_name
  from source_hotels
)
insert into public.hotels (
  tenant_id,
  name,
  address,
  city,
  lat,
  lng,
  zone,
  normalized_name
)
select
  prepared_hotels.tenant_id,
  prepared_hotels.name,
  prepared_hotels.address,
  prepared_hotels.city,
  prepared_hotels.lat,
  prepared_hotels.lng,
  prepared_hotels.zone,
  prepared_hotels.normalized_name
from prepared_hotels
where not exists (
  select 1
  from public.hotels h
  where h.tenant_id = prepared_hotels.tenant_id
    and lower(regexp_replace(regexp_replace(coalesce(h.normalized_name, h.name), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) = prepared_hotels.normalized_name
);

with source_aliases (canonical_name, alias) as (
  values
    ('Hotel Saint Raphael', 'St Raphael'),
    ('Hotel Saint Raphael', 'St. Raphael'),
    ('Hotel Saint Raphael', 'Saint Raphael'),
    ('Hotel Saint Raphael', 'st.raphael'),
    ('Hotel Sorriso', 'Sorriso'),
    ('Park Hotel Imperial', 'Park Imperial'),
    ('Hotel Baia delle Sirene', 'Baia delle Sirene'),
    ('Hotel Tramonto d''Oro', 'Tramonto d''Oro'),
    ('Hotel Villa Franca', 'Villa Franca'),
    ('Hotel Villa al Parco', 'Villa al Parco'),
    ('Park Hotel La Villa', 'Park La Villa'),
    ('Hotel Parco dei Principi', 'Parco dei Principi'),
    ('Hotel Carlo Magno', 'Carlo Magno'),
    ('Hotel Don Pepe', 'Don Pepe'),
    ('Hotel Cristallo', 'Cristallo'),
    ('Hotel Gran Paradiso', 'Gran Paradiso'),
    ('Hotel Stella Maris', 'Stella Maris'),
    ('Hotel Terme President', 'President'),
    ('Grand Hotel delle Terme Re Ferdinando', 'Re Ferdinando'),
    ('Hotel Aragonese', 'Aragona'),
    ('Hotel Terme Felix', 'Felix'),
    ('Hotel Tirrenia', 'Tirrenia'),
    ('Hotel Bristol', 'Bristol'),
    ('Isola Verde Hotel & Thermal Spa', 'Isola Verde'),
    ('San Valentino Terme', 'San Valentino'),
    ('Hotel San Giovanni Terme', 'San Giovanni'),
    ('Hotel Ulisse', 'Ulisse'),
    ('Central Park Terme', 'Central Park'),
    ('Hotel Hermitage', 'Hermitage'),
    ('Hotel Terme Oriente', 'Oriente'),
    ('Hotel Floridiana Terme', 'Floridiana'),
    ('Hotel Continental Terme', 'Continental Terme'),
    ('Hotel Royal Terme', 'Royal Terme'),
    ('Parco Hotel Terme Villa Teresa', 'Villa Teresa'),
    ('Royal Palm Hotel Terme', 'Royal Palm'),
    ('Hotel Zi Carmela', 'Zi Carmela'),
    ('Hotel Terme Colella', 'Colella'),
    ('Hotel La Rosa', 'La Rosa'),
    ('Hotel Punta del Sole', 'Punta del Sole'),
    ('Grand Hotel Terme di Augusto', 'Terme di Augusto')
),
prepared_aliases as (
  select
    'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid as tenant_id,
    h.id as hotel_id,
    source_aliases.alias,
    lower(regexp_replace(regexp_replace(source_aliases.alias, '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as alias_normalized
  from source_aliases
  join public.hotels h
    on h.tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid
   and lower(regexp_replace(regexp_replace(coalesce(h.normalized_name, h.name), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) =
       lower(regexp_replace(regexp_replace(source_aliases.canonical_name, '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g'))
),
deduped_aliases as (
  select distinct on (tenant_id, alias_normalized)
    tenant_id,
    hotel_id,
    alias,
    alias_normalized
  from prepared_aliases
  order by tenant_id, alias_normalized, alias
)
insert into public.hotel_aliases (
  tenant_id,
  hotel_id,
  alias,
  alias_normalized,
  source
)
select
  deduped_aliases.tenant_id,
  deduped_aliases.hotel_id,
  deduped_aliases.alias,
  deduped_aliases.alias_normalized,
  'manual_pdf_departures'
from deduped_aliases
where not exists (
  select 1
  from public.hotel_aliases ha
  where ha.tenant_id = deduped_aliases.tenant_id
    and ha.alias_normalized = deduped_aliases.alias_normalized
);
