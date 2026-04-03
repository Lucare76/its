alter table public.services
  add column if not exists billing_party_name text null;
