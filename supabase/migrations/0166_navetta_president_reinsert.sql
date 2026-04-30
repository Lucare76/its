-- Migration 0166: Reinserimento navette Hotel President
-- La migration 0163 è stata saltata perché l'hotel non era presente al momento
-- dell'applicazione. Questa migration elimina eventuali navette parziali e
-- reinserisce tutte le corse lun-sab dal 2026-04-29 al 2026-12-08.
--
-- Schedule (15 corse A/R al giorno):
--   08:30 09:00 09:30 10:30 11:30 12:00 12:30
--   15:00 16:00 17:00 18:00 18:30 19:00 21:00 22:30
-- Per ogni orario: corsa PAR (hotel→caffè) + corsa ARR 5 min dopo (caffè→hotel)

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
  v_count  int := 0;
begin

  select id into v_hotel
  from public.hotels
  where tenant_id = v_tenant
    and name ilike '%president%'
  order by name
  limit 1;

  if v_hotel is null then
    raise exception '[0166] Hotel President non trovato – migrazione interrotta.';
  end if;

  raise notice '[0166] Hotel President id = %', v_hotel;

  -- Rimuove eventuali navette President già presenti (evita duplicati)
  delete from public.services
  where tenant_id = v_tenant
    and hotel_id   = v_hotel
    and booking_service_kind = 'navetta'
    and date between v_date and v_end;

  -- Reinserisce tutte le corse
  while v_date <= v_end loop
    if extract(dow from v_date) between 1 and 6 then

      foreach v_t in array v_times loop
        v_rt := to_char((v_t::time + interval '5 minutes'), 'HH24:MI');

        -- Corsa PAR: Hotel President → Caffè del Direttore
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
          v_tenant, v_date, v_t::time,
          'transfer'::service_type, 'departure'::service_direction,
          'Hotel President', 1,
          v_hotel, 'Navetta',
          'navetta',
          v_caffe,
          '', '',
          'new', false
        );

        -- Corsa ARR: Caffè del Direttore → Hotel President
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
          v_tenant, v_date, v_rt::time,
          'transfer'::service_type, 'arrival'::service_direction,
          'Hotel President', 1,
          v_hotel, 'Navetta',
          'navetta',
          v_caffe,
          '', '',
          'new', false
        );

        v_count := v_count + 2;
      end loop;
    end if;

    v_date := v_date + 1;
  end loop;

  raise notice '[0166] Inseriti % servizi navetta President (lun-sab % → %)', v_count, '2026-04-29', v_end;
end $$;
