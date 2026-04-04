-- Migration: agency booking module fields on services table

alter table public.services
  add column if not exists booking_service_kind text null;

alter table public.services
  add column if not exists customer_first_name text null;

alter table public.services
  add column if not exists customer_last_name text null;

alter table public.services
  add column if not exists customer_email text null;

alter table public.services
  add column if not exists arrival_date date null;

alter table public.services
  add column if not exists arrival_time time null;

alter table public.services
  add column if not exists departure_date date null;

alter table public.services
  add column if not exists departure_time time null;

alter table public.services
  add column if not exists transport_code text null;

alter table public.services
  add column if not exists bus_city_origin text null;

alter table public.services
  add column if not exists include_ferry_tickets boolean not null default false;

alter table public.services
  add column if not exists ferry_details jsonb not null default '{}'::jsonb;

alter table public.services
  add column if not exists excursion_details jsonb not null default '{}'::jsonb;

alter table public.services
  add column if not exists email_confirmation_to text null;

alter table public.services
  add column if not exists email_confirmation_status text null;

alter table public.services
  add column if not exists email_confirmation_error text null;

alter table public.services
  add column if not exists email_confirmation_sent_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_booking_service_kind_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_booking_service_kind_valid
      check (
        booking_service_kind is null
        or booking_service_kind in (
          'transfer_port_hotel',
          'transfer_airport_hotel',
          'transfer_train_hotel',
          'bus_city_hotel',
          'excursion'
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_email_confirmation_status_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_email_confirmation_status_valid
      check (
        email_confirmation_status is null
        or email_confirmation_status in ('pending', 'sent', 'failed', 'skipped')
      );
  end if;
end $$;

create index if not exists idx_services_booking_kind_date on public.services (tenant_id, booking_service_kind, date, time);
create index if not exists idx_services_email_confirmation_status on public.services (tenant_id, email_confirmation_status, created_at desc);
