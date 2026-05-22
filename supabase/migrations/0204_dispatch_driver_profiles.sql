-- Dispatch can assign operational driver profiles even when the driver has no app account yet.

alter table public.assignments
  add column if not exists driver_profile_id uuid null references public.driver_profiles (id) on delete set null;

alter table public.trip_groups
  add column if not exists driver_profile_id uuid null references public.driver_profiles (id) on delete set null;

create index if not exists assignments_driver_profile
  on public.assignments (tenant_id, driver_profile_id)
  where driver_profile_id is not null;

create index if not exists trip_groups_driver_profile
  on public.trip_groups (tenant_id, driver_profile_id, date)
  where driver_profile_id is not null;

update public.assignments a
set driver_profile_id = p.id
from public.driver_profiles p
where a.driver_profile_id is null
  and a.driver_user_id = p.user_id
  and a.tenant_id = p.tenant_id;

update public.trip_groups tg
set driver_profile_id = p.id
from public.driver_profiles p
where tg.driver_profile_id is null
  and tg.driver_user_id = p.user_id
  and tg.tenant_id = p.tenant_id;
