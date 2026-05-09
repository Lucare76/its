-- Ensure driver availability can be addressed by the operational driver profile.
-- The API also has an update/insert fallback so existing live databases keep working
-- until this migration is applied.

do $$
begin
  if exists (
    select 1
    from public.driver_daily_availability
    where driver_profile_id is not null
    group by tenant_id, driver_profile_id, date
    having count(*) > 1
  ) then
    raise exception 'Duplicate driver_daily_availability rows for tenant_id, driver_profile_id, date';
  end if;
end
$$;

create unique index if not exists driver_daily_availability_tenant_driver_date_key
  on public.driver_daily_availability (tenant_id, driver_profile_id, date)
  where driver_profile_id is not null;
