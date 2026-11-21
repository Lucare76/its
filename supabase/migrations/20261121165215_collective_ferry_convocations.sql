-- Only the authorized operational server reads/writes these tenant-scoped settings.
-- No fake driver, assignment, trip or notification is created by a convocation.
create table public.collective_ferry_convocations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  date date not null,
  event_key text not null check (length(event_key) between 1 and 500),
  active boolean not null default true,
  last_departure time not null,
  margin_min integer not null default 25 check (margin_min between 25 and 35),
  margin_max integer not null default 35 check (margin_max between 25 and 35),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, date, event_key),
  check (margin_min <= margin_max)
);
alter table public.collective_ferry_convocations enable row level security;
revoke all on public.collective_ferry_convocations from public, anon, authenticated;
grant select, insert, update, delete on public.collective_ferry_convocations to service_role;
-- Explicit deny for client roles: the operations API applies membership/tenant authorization.
create policy collective_no_client_access on public.collective_ferry_convocations
  for all to authenticated using (false) with check (false);
