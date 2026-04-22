-- 0148: Campi A/R, pickup_time, fascia oraria e nuovi tipi servizio
--
-- linked_service_id: collega andata e ritorno di uno stesso servizio A/R in giornata
-- pickup_time:       orario prelevamento dal hotel (HH:MM), esplicito per ogni tratta
-- time_from/time_to: fascia oraria per servizi "Privato sull'Isola" e disposizioni a ore
-- Nuovi booking_service_kind: transfer_hotel_hotel, shuttle_hotel, private_island

alter table public.services
  add column if not exists linked_service_id uuid null
    references public.services(id) on delete set null,
  add column if not exists pickup_time text null,
  add column if not exists time_from text null,
  add column if not exists time_to text null;

create index if not exists idx_services_linked
  on public.services(tenant_id, linked_service_id)
  where linked_service_id is not null;

comment on column public.services.linked_service_id is
  'Collega il servizio di ritorno a quello di andata (A/R stesso giorno). Entrambi i record puntano l''uno all''altro.';
comment on column public.services.pickup_time is
  'Orario prelevamento dal hotel (formato HH:MM). Usato per andata e ritorno separatamente.';
comment on column public.services.time_from is
  'Ora inizio fascia di servizio (HH:MM). Usato per Servizio Privato sull''Isola e disposizioni a ore.';
comment on column public.services.time_to is
  'Ora fine fascia di servizio (HH:MM). Usato per Servizio Privato sull''Isola e disposizioni a ore.';

-- Aggiorna constraint booking_service_kind aggiungendo nuovi tipi
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
        'private_island'
      )
    );
end $$;
