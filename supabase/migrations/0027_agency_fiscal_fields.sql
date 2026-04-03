-- Migration: dati fiscali agenzia per fatturazione

alter table public.agencies
  add column if not exists vat_number text null;

alter table public.agencies
  add column if not exists pec_email text null;

alter table public.agencies
  add column if not exists sdi_code text null;
