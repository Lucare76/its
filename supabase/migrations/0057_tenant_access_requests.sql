create table if not exists public.tenant_access_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  requested_role public.app_role null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_notes text null,
  reviewed_by_user_id uuid null references auth.users (id) on delete set null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists idx_tenant_access_requests_tenant_status
  on public.tenant_access_requests (tenant_id, status, created_at desc);

create or replace function public.touch_tenant_access_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tenant_access_requests_updated_at on public.tenant_access_requests;
create trigger trg_tenant_access_requests_updated_at
before update on public.tenant_access_requests
for each row execute procedure public.touch_tenant_access_requests_updated_at();

alter table public.tenant_access_requests enable row level security;

drop policy if exists tenant_access_requests_select_admin on public.tenant_access_requests;
create policy tenant_access_requests_select_admin on public.tenant_access_requests
for select
using (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = tenant_access_requests.tenant_id
      and m.role = 'admin'
      and coalesce(m.suspended, false) = false
  )
);

drop policy if exists tenant_access_requests_insert_self on public.tenant_access_requests;
create policy tenant_access_requests_insert_self on public.tenant_access_requests
for insert
with check (user_id = auth.uid());

drop policy if exists tenant_access_requests_update_admin on public.tenant_access_requests;
create policy tenant_access_requests_update_admin on public.tenant_access_requests
for update
using (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = tenant_access_requests.tenant_id
      and m.role = 'admin'
      and coalesce(m.suspended, false) = false
  )
)
with check (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = tenant_access_requests.tenant_id
      and m.role = 'admin'
      and coalesce(m.suspended, false) = false
  )
);
