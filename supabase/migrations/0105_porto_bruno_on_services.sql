-- Migration 0105: porto_bruno su services
-- Per le partenze (direction = 'departure') con place_type stazione/aeroporto,
-- indica il porto continentale dove Bruno ritira il cliente (es. "Napoli Beverello", "Pozzuoli").
-- Calcolato da calc-pickup-time e salvato al momento della creazione del servizio.

alter table public.services
  add column if not exists porto_bruno text null;

comment on column public.services.porto_bruno is
  'Porto continentale dove Bruno ritira il cliente per i servizi di partenza (Napoli Beverello, Pozzuoli). Usato nelle Liste Bruno.';
