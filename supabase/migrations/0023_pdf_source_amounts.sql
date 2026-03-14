alter table public.services
  add column if not exists source_total_amount_cents integer null,
  add column if not exists source_price_per_pax_cents integer null,
  add column if not exists source_amount_currency text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_source_total_amount_nonneg'
  ) then
    alter table public.services
      add constraint services_source_total_amount_nonneg
      check (source_total_amount_cents is null or source_total_amount_cents >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_source_price_per_pax_nonneg'
  ) then
    alter table public.services
      add constraint services_source_price_per_pax_nonneg
      check (source_price_per_pax_cents is null or source_price_per_pax_cents >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_source_amount_currency_upper'
  ) then
    alter table public.services
      add constraint services_source_amount_currency_upper
      check (source_amount_currency is null or source_amount_currency = upper(source_amount_currency));
  end if;
end $$;
