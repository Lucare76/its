alter table public.memberships
  add column if not exists agency_id uuid null references public.agencies (id) on delete set null;

create index if not exists idx_memberships_tenant_agency
  on public.memberships (tenant_id, agency_id)
  where agency_id is not null;
