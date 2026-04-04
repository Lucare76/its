-- Supabase SQL Editor helper
-- 1) Open Supabase Dashboard -> SQL Editor -> New query
-- 2) Paste this entire file and click Run
-- 3) Run this only after creating:
--    admin@demo.com, operator@demo.com, driver@demo.com, agency@demo.com

with demo_tenant as (
  select id
  from public.tenants
  where name = 'Demo Ischia'
  limit 1
),
demo_emails as (
  select * from (values
    ('admin@demo.com', 'admin'::public.app_role),
    ('operator@demo.com', 'operator'::public.app_role),
    ('driver@demo.com', 'driver'::public.app_role),
    ('agency@demo.com', 'agency'::public.app_role)
  ) as v(email, role)
),
resolved_users as (
  select
    (select id from auth.users where lower(email) = lower(d.email) limit 1) as user_id,
    d.email,
    d.role
  from demo_emails d
)
insert into public.memberships (user_id, tenant_id, role, full_name)
select
  ru.user_id,
  dt.id,
  ru.role,
  initcap(split_part(ru.email, '@', 1)) || ' Demo'
from resolved_users ru
cross join demo_tenant dt
where ru.user_id is not null
on conflict (user_id, tenant_id) do update
set role = excluded.role;
