alter table public.tenant_operational_settings
  add column if not exists split_arrivals_exports boolean not null default true;

alter table public.tenant_operational_settings
  add column if not exists split_departures_exports boolean not null default true;

alter table public.tenant_operational_settings
  add column if not exists monday_bus_send_weekday integer not null default 1 check (monday_bus_send_weekday between 0 and 6);

alter table public.tenant_operational_settings
  add column if not exists report_processing_limit integer not null default 25 check (report_processing_limit between 1 and 100);

alter table public.tenant_operational_settings
  add column if not exists internal_notes text null;
