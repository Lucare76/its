-- Migration: RLS multi-tenant hardening for services/assignments/drivers/hotels/inbound_emails

alter table public.services
  add column if not exists created_by_user_id uuid null references auth.users (id) on delete set null;

alter table public.services
  alter column created_by_user_id set default auth.uid();

create index if not exists idx_services_tenant_created_by on public.services (tenant_id, created_by_user_id);

create or replace function public.is_driver_assigned_service(target_service_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.assignments as a
    where a.service_id = target_service_id
      and a.tenant_id = public.current_tenant_id()
      and a.driver_user_id = auth.uid()
  )
$$;

drop policy if exists services_tenant_select on public.services;
drop policy if exists services_admin_operator_insert on public.services;
drop policy if exists services_admin_operator_update on public.services;
drop policy if exists services_driver_update_assigned on public.services;
drop policy if exists services_admin_operator_delete on public.services;
drop policy if exists services_select_admin_operator_tenant on public.services;
drop policy if exists services_select_driver_assigned on public.services;
drop policy if exists services_select_agency_owned on public.services;
drop policy if exists services_insert_admin_operator on public.services;
drop policy if exists services_insert_agency_owned on public.services;
drop policy if exists services_update_admin_operator on public.services;
drop policy if exists services_update_driver_assigned on public.services;
drop policy if exists services_update_agency_owned on public.services;
drop policy if exists services_delete_admin_operator on public.services;

create policy services_select_admin_operator_tenant on public.services
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_select_driver_assigned on public.services
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(id)
);

create policy services_select_agency_owned on public.services
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
);

create policy services_insert_admin_operator on public.services
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_insert_agency_owned on public.services
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
);

create policy services_update_admin_operator on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_update_driver_assigned on public.services
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

create policy services_update_agency_owned on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
);

create policy services_delete_admin_operator on public.services
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists assignments_tenant_select on public.assignments;
drop policy if exists assignments_admin_operator_insert on public.assignments;
drop policy if exists assignments_admin_operator_update on public.assignments;
drop policy if exists assignments_admin_operator_delete on public.assignments;
drop policy if exists assignments_select_admin_operator_tenant on public.assignments;
drop policy if exists assignments_select_driver_own on public.assignments;
drop policy if exists assignments_select_agency_owned_service on public.assignments;
drop policy if exists assignments_insert_admin_operator on public.assignments;
drop policy if exists assignments_update_admin_operator on public.assignments;
drop policy if exists assignments_delete_admin_operator on public.assignments;

create policy assignments_select_admin_operator_tenant on public.assignments
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_select_driver_own on public.assignments
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and driver_user_id = auth.uid()
);

create policy assignments_select_agency_owned_service on public.assignments
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and exists (
    select 1
    from public.services as s
    where s.id = service_id
      and s.tenant_id = public.current_tenant_id()
      and s.created_by_user_id = auth.uid()
  )
);

create policy assignments_insert_admin_operator on public.assignments
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_update_admin_operator on public.assignments
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_delete_admin_operator on public.assignments
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists memberships_self_or_tenant_select on public.memberships;
drop policy if exists memberships_admin_operator_insert on public.memberships;
drop policy if exists memberships_admin_operator_update on public.memberships;
drop policy if exists memberships_admin_operator_delete on public.memberships;
drop policy if exists memberships_select_self_or_admin_operator on public.memberships;
drop policy if exists memberships_insert_admin_operator on public.memberships;
drop policy if exists memberships_update_admin_operator on public.memberships;
drop policy if exists memberships_delete_admin_operator on public.memberships;

create policy memberships_select_self_or_admin_operator on public.memberships
for select
using (
  user_id = auth.uid()
  or (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
);

create policy memberships_insert_admin_operator on public.memberships
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_update_admin_operator on public.memberships
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_delete_admin_operator on public.memberships
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists hotels_tenant_all on public.hotels;
drop policy if exists hotels_select_tenant_member on public.hotels;
drop policy if exists hotels_insert_admin_operator on public.hotels;
drop policy if exists hotels_update_admin_operator on public.hotels;
drop policy if exists hotels_delete_admin_operator on public.hotels;

create policy hotels_select_tenant_member on public.hotels
for select
using (tenant_id = public.current_tenant_id());

create policy hotels_insert_admin_operator on public.hotels
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy hotels_update_admin_operator on public.hotels
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy hotels_delete_admin_operator on public.hotels
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists inbound_emails_tenant_all on public.inbound_emails;
drop policy if exists inbound_emails_select_admin_operator on public.inbound_emails;
drop policy if exists inbound_emails_insert_admin_operator on public.inbound_emails;
drop policy if exists inbound_emails_update_admin_operator on public.inbound_emails;
drop policy if exists inbound_emails_delete_admin_operator on public.inbound_emails;

create policy inbound_emails_select_admin_operator on public.inbound_emails
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_insert_admin_operator on public.inbound_emails
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_update_admin_operator on public.inbound_emails
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_delete_admin_operator on public.inbound_emails
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists status_events_tenant_select on public.status_events;
drop policy if exists status_events_admin_operator_insert on public.status_events;
drop policy if exists status_events_driver_insert_assigned on public.status_events;
drop policy if exists status_events_admin_operator_update on public.status_events;
drop policy if exists status_events_admin_operator_delete on public.status_events;
drop policy if exists status_events_select_admin_operator_tenant on public.status_events;
drop policy if exists status_events_select_driver_assigned on public.status_events;
drop policy if exists status_events_select_agency_owned_service on public.status_events;
drop policy if exists status_events_insert_admin_operator on public.status_events;
drop policy if exists status_events_insert_driver_assigned on public.status_events;
drop policy if exists status_events_insert_agency_owned_service on public.status_events;
drop policy if exists status_events_update_admin_operator on public.status_events;
drop policy if exists status_events_delete_admin_operator on public.status_events;

create policy status_events_select_admin_operator_tenant on public.status_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_select_driver_assigned on public.status_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(service_id)
);

create policy status_events_select_agency_owned_service on public.status_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and exists (
    select 1
    from public.services as s
    where s.id = service_id
      and s.tenant_id = public.current_tenant_id()
      and s.created_by_user_id = auth.uid()
  )
);

create policy status_events_insert_admin_operator on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_insert_driver_assigned on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and by_user_id = auth.uid()
  and public.is_driver_assigned_service(service_id)
);

create policy status_events_insert_agency_owned_service on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and by_user_id = auth.uid()
  and exists (
    select 1
    from public.services as s
    where s.id = service_id
      and s.tenant_id = public.current_tenant_id()
      and s.created_by_user_id = auth.uid()
  )
);

create policy status_events_update_admin_operator on public.status_events
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_delete_admin_operator on public.status_events
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
