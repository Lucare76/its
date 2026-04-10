alter table public.hotels
  add column if not exists small_vehicle_only boolean not null default false,
  add column if not exists small_vehicle_max_pax integer null;

alter table public.hotels
  drop constraint if exists hotels_small_vehicle_max_pax_check;

alter table public.hotels
  add constraint hotels_small_vehicle_max_pax_check
  check (small_vehicle_max_pax is null or (small_vehicle_max_pax >= 1 and small_vehicle_max_pax <= 60));

comment on column public.hotels.small_vehicle_only is 'Quando true, per l''assegnazione Ischia l''hotel puo essere servito solo da mezzo piccolo.';
comment on column public.hotels.small_vehicle_max_pax is 'Capienza massima consigliata per il mezzo piccolo su questo hotel.';
