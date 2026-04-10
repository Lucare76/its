-- Migration: onboarding entities (vehicles + tenant geo settings) and stricter memberships write RBAC

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  label text not null,
  plate text null,
  capacity integer null check (capacity is null or capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_geo_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  zones text[] not null default '{}',
  ports text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_vehicles_tenant_id on public.vehicles (tenant_id);
create index if not exists idx_tenant_geo_settings_updated_at on public.tenant_geo_settings (updated_at desc);

alter table public.vehicles enable row level security;
alter table public.tenant_geo_settings enable row level security;

drop policy if exists vehicles_tenant_select on public.vehicles;
drop policy if exists vehicles_admin_operator_insert on public.vehicles;
drop policy if exists vehicles_admin_operator_update on public.vehicles;
drop policy if exists vehicles_admin_operator_delete on public.vehicles;

create policy vehicles_tenant_select on public.vehicles
for select
using (tenant_id = public.current_tenant_id());

create policy vehicles_admin_operator_insert on public.vehicles
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy vehicles_admin_operator_update on public.vehicles
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy vehicles_admin_operator_delete on public.vehicles
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists tenant_geo_settings_tenant_select on public.tenant_geo_settings;
drop policy if exists tenant_geo_settings_admin_operator_insert on public.tenant_geo_settings;
drop policy if exists tenant_geo_settings_admin_operator_update on public.tenant_geo_settings;
drop policy if exists tenant_geo_settings_admin_operator_delete on public.tenant_geo_settings;

create policy tenant_geo_settings_tenant_select on public.tenant_geo_settings
for select
using (tenant_id = public.current_tenant_id());

create policy tenant_geo_settings_admin_operator_insert on public.tenant_geo_settings
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_geo_settings_admin_operator_update on public.tenant_geo_settings
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_geo_settings_admin_operator_delete on public.tenant_geo_settings
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists memberships_tenant_all on public.memberships;
drop policy if exists memberships_admin_operator_insert on public.memberships;
drop policy if exists memberships_admin_operator_update on public.memberships;
drop policy if exists memberships_admin_operator_delete on public.memberships;

create policy memberships_admin_operator_insert on public.memberships
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_admin_operator_update on public.memberships
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_admin_operator_delete on public.memberships
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
