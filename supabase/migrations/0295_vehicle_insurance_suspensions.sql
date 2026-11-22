alter table public.vehicle_insurances
  add column if not exists suspended_from date,
  add column if not exists suspended_until date,
  add column if not exists reactivated_on date;
alter table public.vehicle_insurances
  add constraint vehicle_insurances_suspension_dates_check check (
    (suspended_from is null and suspended_until is null and reactivated_on is null)
    or (suspended_from is not null and suspended_until is not null
      and suspended_until >= suspended_from
      and (reactivated_on is null or reactivated_on >= suspended_from))
  );
