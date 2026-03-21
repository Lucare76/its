alter table public.services
  drop constraint if exists services_service_type_code_valid;

alter table public.services
  add constraint services_service_type_code_valid
  check (
    service_type_code is null
    or service_type_code in (
      'transfer_station_hotel',
      'transfer_airport_hotel',
      'transfer_port_hotel',
      'transfer_hotel_port',
      'excursion',
      'ferry_transfer',
      'bus_line'
    )
  );
