-- Allinea profili autisti, accessi e disponibilita su una chiave stabile.
-- driver_profiles resta la scheda operativa del driver, collegata opzionalmente
-- all'utente auth/membership tramite user_id.

alter table public.driver_profiles
  add column if not exists user_id uuid null references auth.users (id) on delete set null;

create unique index if not exists idx_driver_profiles_tenant_user
  on public.driver_profiles (tenant_id, user_id)
  where user_id is not null;

alter table public.driver_daily_availability
  add column if not exists driver_profile_id uuid null references public.driver_profiles (id) on delete set null;

alter table public.driver_daily_availability
  alter column driver_user_id drop not null;

create unique index if not exists idx_driver_daily_avail_profile_date
  on public.driver_daily_availability (tenant_id, driver_profile_id, date)
  where driver_profile_id is not null;

with normalized_memberships as (
  select
    m.tenant_id,
    m.user_id,
    m.full_name,
    lower(regexp_replace(trim(m.full_name), '\s+', ' ', 'g')) as normalized_name
  from public.memberships m
  where m.role::text in ('driver', 'autista')
),
normalized_profiles as (
  select
    p.id,
    p.tenant_id,
    p.full_name,
    p.user_id,
    lower(regexp_replace(trim(p.full_name), '\s+', ' ', 'g')) as normalized_name
  from public.driver_profiles p
),
matches as (
  select
    p.id as profile_id,
    m.user_id
  from normalized_profiles p
  join normalized_memberships m
    on m.tenant_id = p.tenant_id
   and m.normalized_name = p.normalized_name
  where p.user_id is null
)
update public.driver_profiles p
set user_id = matches.user_id
from matches
where p.id = matches.profile_id;

insert into public.driver_profiles (tenant_id, user_id, full_name, active)
select
  m.tenant_id,
  m.user_id,
  m.full_name,
  true
from public.memberships m
left join public.driver_profiles p
  on p.tenant_id = m.tenant_id
 and p.user_id = m.user_id
where m.role::text in ('driver', 'autista')
  and p.id is null;

update public.driver_daily_availability dda
set driver_profile_id = p.id
from public.driver_profiles p
where dda.tenant_id = p.tenant_id
  and dda.driver_user_id = p.user_id
  and dda.driver_profile_id is null;

update public.vehicles v
set habitual_driver_user_id = p.user_id
from public.driver_profiles p
where v.habitual_driver_profile_id = p.id
  and (v.habitual_driver_user_id is null or v.habitual_driver_user_id <> p.user_id);
