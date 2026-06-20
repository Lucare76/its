-- Migration 0225: aggiunta campi agenzia ai preventivi
-- is_agency: distingue preventivo per agenzia da cliente diretto
-- end_customer_name: nome del cliente finale (visibile quando is_agency = true)

alter table public.service_quotes
  add column if not exists is_agency          boolean not null default false,
  add column if not exists end_customer_name  text;
