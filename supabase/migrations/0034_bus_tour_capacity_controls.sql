alter table public.services
  add column if not exists low_seat_threshold integer null;

alter table public.services
  add column if not exists minimum_passengers integer null;

alter table public.services
  add column if not exists waitlist_enabled boolean not null default false;

alter table public.services
  add column if not exists waitlist_count integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_low_seat_threshold_valid'
  ) then
    alter table public.services
      add constraint services_low_seat_threshold_valid
      check (low_seat_threshold is null or low_seat_threshold between 0 and 120);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_minimum_passengers_valid'
  ) then
    alter table public.services
      add constraint services_minimum_passengers_valid
      check (minimum_passengers is null or minimum_passengers between 1 and 120);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_waitlist_count_valid'
  ) then
    alter table public.services
      add constraint services_waitlist_count_valid
      check (waitlist_count between 0 and 500);
  end if;
end $$;
