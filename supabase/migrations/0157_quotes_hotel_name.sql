-- Aggiunge colonna hotel_name alla tabella quotes
alter table public.quotes
  add column if not exists hotel_name text null;
