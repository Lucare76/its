alter table public.tenant_bus_units
  add column if not exists driver_name text null,
  add column if not exists driver_phone text null;
