-- Aggiunge formula_snav e formula_medmar come valori validi di booking_service_kind
-- Necessario per distinguere SNAV da MEDMAR nell'area agenzia

do $$
begin
  -- Rimuovi il vecchio constraint (che non includeva formula_snav / formula_medmar)
  if exists (
    select 1 from pg_constraint
    where conname = 'services_booking_service_kind_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      drop constraint services_booking_service_kind_valid;
  end if;

  -- Ricrea con i nuovi valori
  alter table public.services
    add constraint services_booking_service_kind_valid
    check (
      booking_service_kind is null
      or booking_service_kind in (
        'transfer_port_hotel',
        'transfer_airport_hotel',
        'transfer_train_hotel',
        'bus_city_hotel',
        'excursion',
        'formula_snav',
        'formula_medmar'
      )
    );
end $$;
