-- Autista separato per andata e ritorno su tenant_bus_units
-- I campi esistenti driver_name/driver_phone diventano _outbound

alter table public.tenant_bus_units
  rename column driver_name  to driver_name_outbound;

alter table public.tenant_bus_units
  rename column driver_phone to driver_phone_outbound;

alter table public.tenant_bus_units
  add column if not exists driver_name_return  text null,
  add column if not exists driver_phone_return text null;
