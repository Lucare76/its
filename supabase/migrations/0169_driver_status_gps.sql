-- Migration 0169: Nuovi stati driver (caricato/scaricato) + GPS su status_events
-- caricato = autista ha ritirato il cliente al porto (arrivi)
-- scaricato = autista ha consegnato il cliente all'hotel (arrivi)

alter type public.service_status add value if not exists 'caricato';
alter type public.service_status add value if not exists 'scaricato';

alter table public.status_events
  add column if not exists gps_lat  numeric(10, 8) null,
  add column if not exists gps_lng  numeric(11, 8) null;

comment on column public.status_events.gps_lat is 'Latitudine GPS al momento del click (da Radius/Kinesis o browser)';
comment on column public.status_events.gps_lng is 'Longitudine GPS al momento del click';
