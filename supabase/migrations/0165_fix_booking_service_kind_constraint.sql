-- Migration 0165: Ripristina il constraint booking_service_kind con lista completa.
-- La migration 0163 ha ricostruito il constraint dinamicamente (dai valori esistenti
-- in services) potendo escludere kind validi (es. formula_medmar_napoli/pozzuoli)
-- se non ancora presenti nel DB al momento dell'esecuzione.
-- Questa migration lo ridefinisce staticamente con tutti i valori noti.

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'services_booking_service_kind_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services drop constraint services_booking_service_kind_valid;
  end if;

  alter table public.services
    add constraint services_booking_service_kind_valid
    check (
      booking_service_kind is null
      or booking_service_kind in (
        'transfer_port_hotel',
        'transfer_airport_hotel',
        'transfer_airport_hotel_exclusive',
        'transfer_airport_hotel_aliscafo',
        'transfer_train_hotel',
        'transfer_train_hotel_exclusive',
        'transfer_train_hotel_aliscafo',
        'bus_city_hotel',
        'excursion',
        'formula_snav',
        'formula_medmar_napoli',
        'formula_medmar_pozzuoli',
        'transfer_hotel_hotel',
        'shuttle_hotel',
        'private_island',
        'navetta'
      )
    );
end $$;
