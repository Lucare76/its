-- Migration 0106: campi calcolati da calc-pickup-time su services
-- Per i servizi di partenza con place_type station/airport, questi campi vengono
-- popolati automaticamente al momento della creazione tramite calcPickupTime().

alter table public.services
  add column if not exists pickup_hotel text null,
  add column if not exists barca_compagnia text null,
  add column if not exists orario_barca text null,
  add column if not exists pickup_alert text null;

comment on column public.services.pickup_hotel is
  'Orario prelievo dal hotel (HH:MM) calcolato da calcPickupTime. Usato nel promemoria WhatsApp 48h prima della partenza.';
comment on column public.services.barca_compagnia is
  'Compagnia traghetto/aliscafo calcolata (Medmar | Alilauro | Snav). Aggiorna anche il campo vessel.';
comment on column public.services.orario_barca is
  'Orario partenza barca da Ischia (HH:MM) calcolato da calcPickupTime.';
comment on column public.services.pickup_alert is
  'Alert testuale se la fascia oraria è anomala (es. volo troppo presto → partire giorno prima).';
