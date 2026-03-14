alter table public.services
  add column if not exists service_type_code text null,
  add column if not exists train_arrival_number text null,
  add column if not exists train_arrival_time text null,
  add column if not exists train_departure_number text null,
  add column if not exists train_departure_time text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_service_type_code_valid'
  ) then
    alter table public.services
      add constraint services_service_type_code_valid
      check (
        service_type_code is null
        or service_type_code in (
          'transfer_station_hotel',
          'transfer_port_hotel',
          'transfer_hotel_port',
          'excursion',
          'ferry_transfer'
        )
      );
  end if;
end $$;
