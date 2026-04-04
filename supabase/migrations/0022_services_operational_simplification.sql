alter table public.services
  add column if not exists outbound_time text null,
  add column if not exists return_time text null;
