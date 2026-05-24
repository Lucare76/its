-- Migration 0206: aggiungi swift_code a service_quotes e tenants

alter table public.service_quotes
  add column if not exists swift_code text;

alter table public.tenants
  add column if not exists quote_swift_code text;

-- Imposta dati bancari default dove non ancora valorizzati
update public.tenants
  set quote_bank_holder = 'ISCHIA TRANSFER SERVICE SRL'
where quote_bank_holder is null;

update public.tenants
  set quote_iban = 'IT70O0103039931000063265467'
where quote_iban is null;

update public.tenants
  set quote_swift_code = 'BA6ET11'
where quote_swift_code is null;
