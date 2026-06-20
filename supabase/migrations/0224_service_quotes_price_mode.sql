alter table public.service_quotes
  add column if not exists price_mode text not null default 'per_person'
  check (price_mode in ('per_person', 'total'));

alter table public.service_quote_items
  add column if not exists price_mode text not null default 'per_person'
  check (price_mode in ('per_person', 'total'));
