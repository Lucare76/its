-- Aggiunge campi cliente e token di risposta alla tabella quotes
alter table public.quotes
  add column if not exists client_name text null,
  add column if not exists client_email text null,
  add column if not exists response_token text null default gen_random_uuid()::text;

-- Indice per ricerca veloce per token
create unique index if not exists idx_quotes_response_token on public.quotes (response_token) where response_token is not null;
