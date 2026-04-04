create table if not exists public.role_capability_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role text not null check (role in ('admin', 'operator', 'driver', 'agency')),
  capability text not null,
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, role, capability)
);

create index if not exists idx_role_capability_overrides_tenant_role
  on public.role_capability_overrides (tenant_id, role);

create index if not exists idx_role_capability_overrides_tenant_capability
  on public.role_capability_overrides (tenant_id, capability);

create or replace function public.touch_role_capability_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_role_capability_overrides_updated_at on public.role_capability_overrides;
create trigger trg_role_capability_overrides_updated_at
before update on public.role_capability_overrides
for each row execute procedure public.touch_role_capability_overrides_updated_at();

alter table public.role_capability_overrides enable row level security;

drop policy if exists role_capability_overrides_select_admin on public.role_capability_overrides;
create policy role_capability_overrides_select_admin on public.role_capability_overrides
for select
using (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = role_capability_overrides.tenant_id
      and m.role = 'admin'
  )
);

drop policy if exists role_capability_overrides_insert_admin on public.role_capability_overrides;
create policy role_capability_overrides_insert_admin on public.role_capability_overrides
for insert
with check (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = role_capability_overrides.tenant_id
      and m.role = 'admin'
  )
);

drop policy if exists role_capability_overrides_update_admin on public.role_capability_overrides;
create policy role_capability_overrides_update_admin on public.role_capability_overrides
for update
using (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = role_capability_overrides.tenant_id
      and m.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = role_capability_overrides.tenant_id
      and m.role = 'admin'
  )
);

drop policy if exists role_capability_overrides_delete_admin on public.role_capability_overrides;
create policy role_capability_overrides_delete_admin on public.role_capability_overrides
for delete
using (
  exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = role_capability_overrides.tenant_id
      and m.role = 'admin'
  )
);
