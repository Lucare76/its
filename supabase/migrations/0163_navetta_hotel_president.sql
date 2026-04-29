-- Migration 0163: Navetta Hotel President ↔ Caffè del Direttore
-- Servizio fisso lunedì-sabato, 29 apr 2026 – 08 dic 2026.
-- 15 corse A/R al giorno: ogni riga genera la corsa andata (President → Caffè)
-- e 5 minuti dopo la corsa ritorno (Caffè → President).
-- Il mezzo viene assegnato giornalmente dall'operatore.

-- ── 1. Aggiunge 'navetta' come booking_service_kind valido ────────────────────

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'services_booking_service_kind_valid'
  ) then
    alter table public.services
      drop constraint services_booking_service_kind_valid;
  end if;

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
        'formula_medmar',
        'navetta'
      )
    );
end $$;

-- ── 2. Inserisce i servizi navetta ────────────────────────────────────────────

do $$
declare
  v_tenant uuid  := 'd200b89a-64c7-4f8d-a430-95a33b83047a';
  v_hotel  uuid;
  v_date   date  := '2026-04-29';
  v_end    date  := '2026-12-08';
  v_caffe  text  := 'Piazzale Trieste 6, Ischia (Caffè del Direttore)';
  v_times  text[] := ARRAY[
    '08:30','09:00','09:30','10:30','11:30','12:00','12:30',
    '15:00','16:00','17:00','18:00','18:30','19:00','21:00','22:30'
  ];
  v_t      text;
  v_rt     text;
begin

  -- Trova Hotel President (prende il primo match per nome)
  select id into v_hotel
  from public.hotels
  where tenant_id = v_tenant
    and name ilike '%president%'
  order by name
  limit 1;

  if v_hotel is null then
    raise notice '[0163] Hotel President non trovato – migrazione saltata.';
    return;
  end if;

  raise notice '[0163] Hotel President id = %', v_hotel;

  -- Loop giornaliero lunedì(1)–sabato(6), salta domenica(0)
  while v_date <= v_end loop
    if extract(dow from v_date) between 1 and 6 then

      foreach v_t in array v_times loop
        -- Orario ritorno = andata + 5 minuti
        v_rt := to_char((v_t::time + interval '5 minutes'), 'HH24:MI');

        -- Corsa A: Hotel President → Caffè del Direttore
        insert into public.services (
          tenant_id, date, time,
          service_type, direction,
          customer_name, pax,
          hotel_id, vessel,
          booking_service_kind,
          meeting_point,
          notes, phone,
          status, is_draft
        ) values (
          v_tenant, v_date, v_t,
          'transfer', 'departure',
          'Hotel President', 1,
          v_hotel, 'Navetta',
          'navetta',
          v_caffe,
          '', '',
          'new', false
        );

        -- Corsa R: Caffè del Direttore → Hotel President
        insert into public.services (
          tenant_id, date, time,
          service_type, direction,
          customer_name, pax,
          hotel_id, vessel,
          booking_service_kind,
          meeting_point,
          notes, phone,
          status, is_draft
        ) values (
          v_tenant, v_date, v_rt,
          'transfer', 'arrival',
          'Hotel President', 1,
          v_hotel, 'Navetta',
          'navetta',
          v_caffe,
          '', '',
          'new', false
        );

      end loop;
    end if;

    v_date := v_date + 1;
  end loop;

  raise notice '[0163] Migrazione completata fino al %', v_end;
end $$;
