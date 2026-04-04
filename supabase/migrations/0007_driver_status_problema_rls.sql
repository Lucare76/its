-- Migration: add "problema" status and restrict driver status updates to assigned services

do $$
begin
  alter type public.service_status add value if not exists 'problema';
exception
  when duplicate_object then null;
end
$$;

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
as $$
  select role
  from public.memberships
  where user_id = auth.uid()
    and tenant_id = public.current_tenant_id()
  order by created_at asc
  limit 1
$$;

create or replace function public.is_driver_assigned_service(target_service_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.assignments as a
    join public.services as s on s.id = a.service_id
    where a.service_id = target_service_id
      and a.driver_user_id = auth.uid()
      and s.tenant_id = public.current_tenant_id()
  )
$$;

drop policy if exists services_tenant_all on public.services;
drop policy if exists "services_tenant_all" on public.services;
drop policy if exists services_tenant_select on public.services;
drop policy if exists services_admin_operator_insert on public.services;
drop policy if exists services_admin_operator_update on public.services;
drop policy if exists services_driver_update_assigned on public.services;
drop policy if exists services_admin_operator_delete on public.services;

create policy services_tenant_select on public.services
for select
using (tenant_id = public.current_tenant_id());

create policy services_admin_operator_insert on public.services
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_admin_operator_update on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_driver_update_assigned on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(id)
);

create policy services_admin_operator_delete on public.services
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists assignments_tenant_all on public.assignments;
drop policy if exists "assignments_tenant_all" on public.assignments;
drop policy if exists assignments_tenant_select on public.assignments;
drop policy if exists assignments_admin_operator_insert on public.assignments;
drop policy if exists assignments_admin_operator_update on public.assignments;
drop policy if exists assignments_admin_operator_delete on public.assignments;

create policy assignments_tenant_select on public.assignments
for select
using (tenant_id = public.current_tenant_id());

create policy assignments_admin_operator_insert on public.assignments
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_admin_operator_update on public.assignments
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_admin_operator_delete on public.assignments
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists status_events_tenant_all on public.status_events;
drop policy if exists "status_events_tenant_all" on public.status_events;
drop policy if exists status_events_tenant_select on public.status_events;
drop policy if exists status_events_admin_operator_insert on public.status_events;
drop policy if exists status_events_driver_insert_assigned on public.status_events;
drop policy if exists status_events_admin_operator_update on public.status_events;
drop policy if exists status_events_admin_operator_delete on public.status_events;

create policy status_events_tenant_select on public.status_events
for select
using (tenant_id = public.current_tenant_id());

create policy status_events_admin_operator_insert on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_driver_insert_assigned on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and by_user_id = auth.uid()
  and public.is_driver_assigned_service(service_id)
);

create policy status_events_admin_operator_update on public.status_events
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_admin_operator_delete on public.status_events
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
