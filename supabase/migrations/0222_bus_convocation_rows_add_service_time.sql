alter table public.bus_convocation_rows
  add column if not exists service_time text;
