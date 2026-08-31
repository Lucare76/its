alter table public.booking_groups
  add column if not exists return_date date null;

comment on column public.booking_groups.return_date is
  'Data ritorno/uscita del gruppo prenotazione; opzionale. service_date resta la data arrivo/default per retrocompatibilita.';
