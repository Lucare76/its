-- Flag per identificare dati di test — permette pulizia selettiva senza impatto sui dati reali.
alter table public.services
  add column if not exists is_test_data boolean not null default false;

create index if not exists services_is_test_data
  on public.services (tenant_id, is_test_data)
  where is_test_data = true;
