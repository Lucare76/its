alter table public.services
  drop constraint if exists services_pax_check;

alter table public.services
  add constraint services_pax_check check (pax >= 0 and pax <= 500);
