-- Ischia Transfer Beta - RLS verification checklist
-- Run in Supabase SQL Editor after bootstrap/migrations.
-- This script is read-only and returns verification tables.

-- 1) Helper functions used by RLS
select
  routine_name,
  routine_type,
  data_type
from information_schema.routines
where specific_schema = 'public'
  and routine_name in (
    'current_tenant_id',
    'current_user_role',
    'is_driver_assigned_service'
  )
order by routine_name;

-- 2) RLS enabled on core multi-tenant tables
with expected_tables as (
  select * from (values
    ('agencies'),
    ('assignments'),
    ('hotels'),
    ('inbound_emails'),
    ('memberships'),
    ('services'),
    ('status_events'),
    ('tenants'),
    ('vehicles')
  ) as t(table_name)
)
select
  e.table_name,
  case when c.oid is not null then 'OK' else 'MISSING_TABLE' end as table_status,
  case when c.relrowsecurity then 'ON' else 'OFF' end as rls_status
from expected_tables e
left join pg_class c
  on c.relname = e.table_name
left join pg_namespace n
  on n.oid = c.relnamespace
 and n.nspname = 'public'
order by e.table_name;

-- 3) Core policy inventory by role boundary
with expected_policies as (
  select * from (values
    ('agencies', 'agencies_select_tenant_member'),
    ('agencies', 'agencies_insert_admin_operator'),
    ('agencies', 'agencies_update_admin_operator'),
    ('agencies', 'agencies_delete_admin_operator'),
    ('assignments', 'assignments_select_admin_operator_tenant'),
    ('assignments', 'assignments_select_driver_own'),
    ('assignments', 'assignments_select_agency_owned_service'),
    ('assignments', 'assignments_insert_admin_operator'),
    ('assignments', 'assignments_update_admin_operator'),
    ('assignments', 'assignments_delete_admin_operator'),
    ('hotels', 'hotels_select_tenant_member'),
    ('hotels', 'hotels_insert_admin_operator'),
    ('hotels', 'hotels_update_admin_operator'),
    ('hotels', 'hotels_delete_admin_operator'),
    ('inbound_emails', 'inbound_emails_select_admin_operator'),
    ('inbound_emails', 'inbound_emails_insert_admin_operator'),
    ('inbound_emails', 'inbound_emails_update_admin_operator'),
    ('inbound_emails', 'inbound_emails_delete_admin_operator'),
    ('memberships', 'memberships_select_self_or_admin_operator'),
    ('memberships', 'memberships_insert_admin_operator'),
    ('memberships', 'memberships_update_admin_operator'),
    ('memberships', 'memberships_delete_admin_operator'),
    ('services', 'services_select_admin_operator_tenant'),
    ('services', 'services_select_driver_assigned'),
    ('services', 'services_select_agency_owned'),
    ('services', 'services_insert_admin_operator'),
    ('services', 'services_insert_agency_owned'),
    ('services', 'services_update_admin_operator'),
    ('services', 'services_update_driver_assigned'),
    ('services', 'services_update_agency_owned'),
    ('services', 'services_delete_admin_operator'),
    ('status_events', 'status_events_select_admin_operator_tenant'),
    ('status_events', 'status_events_select_driver_assigned'),
    ('status_events', 'status_events_select_agency_owned_service'),
    ('status_events', 'status_events_insert_admin_operator'),
    ('status_events', 'status_events_insert_driver_assigned'),
    ('status_events', 'status_events_insert_agency_owned_service'),
    ('status_events', 'status_events_update_admin_operator'),
    ('status_events', 'status_events_delete_admin_operator'),
    ('tenants', 'tenants_member_select'),
    ('vehicles', 'vehicles_tenant_select'),
    ('vehicles', 'vehicles_admin_operator_insert'),
    ('vehicles', 'vehicles_admin_operator_update'),
    ('vehicles', 'vehicles_admin_operator_delete')
  ) as t(table_name, policy_name)
)
select
  e.table_name,
  e.policy_name,
  case when p.policyname is not null then 'OK' else 'MISSING_POLICY' end as policy_status,
  p.cmd
from expected_policies e
left join pg_policies p
  on p.schemaname = 'public'
 and p.tablename = e.table_name
 and p.policyname = e.policy_name
order by e.table_name, e.policy_name;

-- 4) Focus check: policy expressions for the most sensitive tables
select
  tablename,
  policyname,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and (
    (tablename = 'services' and policyname in (
      'services_select_admin_operator_tenant',
      'services_select_driver_assigned',
      'services_select_agency_owned',
      'services_insert_admin_operator',
      'services_insert_agency_owned',
      'services_update_admin_operator',
      'services_update_driver_assigned',
      'services_update_agency_owned',
      'services_delete_admin_operator'
    ))
    or (tablename = 'assignments' and policyname in (
      'assignments_select_admin_operator_tenant',
      'assignments_select_driver_own',
      'assignments_select_agency_owned_service',
      'assignments_insert_admin_operator',
      'assignments_update_admin_operator',
      'assignments_delete_admin_operator'
    ))
    or (tablename = 'status_events' and policyname in (
      'status_events_select_admin_operator_tenant',
      'status_events_select_driver_assigned',
      'status_events_select_agency_owned_service',
      'status_events_insert_admin_operator',
      'status_events_insert_driver_assigned',
      'status_events_insert_agency_owned_service',
      'status_events_update_admin_operator',
      'status_events_delete_admin_operator'
    ))
  )
order by tablename, policyname;

-- 5) Quick summary counters
with expected_tables as (
  select * from (values
    ('agencies'),
    ('assignments'),
    ('hotels'),
    ('inbound_emails'),
    ('memberships'),
    ('services'),
    ('status_events'),
    ('tenants'),
    ('vehicles')
  ) as t(table_name)
),
expected_policies as (
  select * from (values
    ('agencies', 'agencies_select_tenant_member'),
    ('agencies', 'agencies_insert_admin_operator'),
    ('agencies', 'agencies_update_admin_operator'),
    ('agencies', 'agencies_delete_admin_operator'),
    ('assignments', 'assignments_select_admin_operator_tenant'),
    ('assignments', 'assignments_select_driver_own'),
    ('assignments', 'assignments_select_agency_owned_service'),
    ('assignments', 'assignments_insert_admin_operator'),
    ('assignments', 'assignments_update_admin_operator'),
    ('assignments', 'assignments_delete_admin_operator'),
    ('hotels', 'hotels_select_tenant_member'),
    ('hotels', 'hotels_insert_admin_operator'),
    ('hotels', 'hotels_update_admin_operator'),
    ('hotels', 'hotels_delete_admin_operator'),
    ('inbound_emails', 'inbound_emails_select_admin_operator'),
    ('inbound_emails', 'inbound_emails_insert_admin_operator'),
    ('inbound_emails', 'inbound_emails_update_admin_operator'),
    ('inbound_emails', 'inbound_emails_delete_admin_operator'),
    ('memberships', 'memberships_select_self_or_admin_operator'),
    ('memberships', 'memberships_insert_admin_operator'),
    ('memberships', 'memberships_update_admin_operator'),
    ('memberships', 'memberships_delete_admin_operator'),
    ('services', 'services_select_admin_operator_tenant'),
    ('services', 'services_select_driver_assigned'),
    ('services', 'services_select_agency_owned'),
    ('services', 'services_insert_admin_operator'),
    ('services', 'services_insert_agency_owned'),
    ('services', 'services_update_admin_operator'),
    ('services', 'services_update_driver_assigned'),
    ('services', 'services_update_agency_owned'),
    ('services', 'services_delete_admin_operator'),
    ('status_events', 'status_events_select_admin_operator_tenant'),
    ('status_events', 'status_events_select_driver_assigned'),
    ('status_events', 'status_events_select_agency_owned_service'),
    ('status_events', 'status_events_insert_admin_operator'),
    ('status_events', 'status_events_insert_driver_assigned'),
    ('status_events', 'status_events_insert_agency_owned_service'),
    ('status_events', 'status_events_update_admin_operator'),
    ('status_events', 'status_events_delete_admin_operator'),
    ('tenants', 'tenants_member_select'),
    ('vehicles', 'vehicles_tenant_select'),
    ('vehicles', 'vehicles_admin_operator_insert'),
    ('vehicles', 'vehicles_admin_operator_update'),
    ('vehicles', 'vehicles_admin_operator_delete')
  ) as t(table_name, policy_name)
)
select
  (select count(*) from expected_tables) as expected_table_count,
  (
    select count(*)
    from expected_tables e
    join pg_class c on c.relname = e.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relrowsecurity
  ) as tables_with_rls_on,
  (select count(*) from expected_policies) as expected_policy_count,
  (
    select count(*)
    from expected_policies e
    join pg_policies p
      on p.schemaname = 'public'
     and p.tablename = e.table_name
     and p.policyname = e.policy_name
  ) as matched_policy_count;
