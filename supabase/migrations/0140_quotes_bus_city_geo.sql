-- Salva origine e coordinate della citta per i preventivi linea bus.
alter table public.quotes
  add column if not exists hotel_name text null,
  add column if not exists bus_city_origin text null,
  add column if not exists bus_city_lat double precision null,
  add column if not exists bus_city_lng double precision null,
  add column if not exists bus_city_geo_label text null;

create index if not exists idx_quotes_bus_city_origin
  on public.quotes (tenant_id, bus_city_origin)
  where bus_city_origin is not null;
