-- Migration: align runtime requirements for agency booking API

alter table public.services
  add column if not exists created_by_user_id uuid null;

create index if not exists idx_services_tenant_created_by_date
  on public.services (tenant_id, created_by_user_id, date, time);

alter table public.agencies
  add column if not exists external_code text null;

create unique index if not exists uq_agencies_tenant_external_code
  on public.agencies (tenant_id, external_code)
  where external_code is not null;
