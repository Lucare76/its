-- Divide formula_medmar in formula_medmar_napoli e formula_medmar_pozzuoli.
-- Migra i record esistenti in base all'orario arrivo (Napoli: 08:40/14:20/19:00).

do $$
begin
  -- Prima rimuovi il vecchio constraint (che include 'formula_medmar')
  if exists (
    select 1 from pg_constraint
    where conname = 'services_booking_service_kind_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      drop constraint services_booking_service_kind_valid;
  end if;

  -- Migra i dati PRIMA di aggiungere il nuovo constraint
  -- Arrivi: Napoli se orario 08:40/14:20/19:00, altrimenti Pozzuoli
  -- Partenze: default Pozzuoli (i pochi Napoli vanno corretti manualmente)
  update public.services
  set booking_service_kind =
    case
      when direction = 'arrival' and arrival_time in ('08:40', '14:20', '19:00')
        then 'formula_medmar_napoli'
      else
        'formula_medmar_pozzuoli'
    end
  where booking_service_kind = 'formula_medmar';

  -- Ora aggiungi il constraint senza 'formula_medmar'
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
        'formula_medmar_pozzuoli'
      )
    );
end $$;
