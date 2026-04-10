-- Migration 0108: vehicle_id e driver_profile_id su bus_ischia_dist_buses
-- Il bus di distribuzione è collegato a un veicolo reale della flotta
-- e a un autista dal registro driver_profiles.

alter table public.bus_ischia_dist_buses
  add column if not exists vehicle_id uuid null references public.vehicles (id) on delete set null,
  add column if not exists driver_profile_id uuid null references public.driver_profiles (id) on delete set null;

comment on column public.bus_ischia_dist_buses.vehicle_id is
  'Veicolo dalla flotta reale assegnato a questo bus di distribuzione.';
comment on column public.bus_ischia_dist_buses.driver_profile_id is
  'Autista dal registro driver_profiles assegnato a questo bus di distribuzione.';
