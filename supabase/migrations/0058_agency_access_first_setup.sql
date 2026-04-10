alter table public.tenant_access_requests
  add column if not exists agency_name text null;

alter table public.agencies
  add column if not exists setup_required boolean not null default false;
