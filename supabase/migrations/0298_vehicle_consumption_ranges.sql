alter table public.vehicles
  add column if not exists consumption_min_l_per_100km numeric(6,2),
  add column if not exists consumption_max_l_per_100km numeric(6,2);
alter table public.vehicles add constraint vehicle_consumption_range_valid
  check ((consumption_min_l_per_100km is null or consumption_min_l_per_100km > 0)
    and (consumption_max_l_per_100km is null or consumption_max_l_per_100km > 0)
    and (consumption_min_l_per_100km is null or consumption_max_l_per_100km is null
      or consumption_max_l_per_100km >= consumption_min_l_per_100km));
