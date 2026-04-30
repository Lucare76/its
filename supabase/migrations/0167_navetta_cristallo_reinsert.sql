-- Migration 0167: Reinserimento navette Hotel Cristallo
-- La migration 0164 usava raise notice (skip silenzioso) se l'hotel non era presente.
-- Questa migration elimina eventuali navette parziali e reinserisce tutte le corse
-- lun-sab dal 2026-04-29 al 2026-12-08.
--
-- Schedule (6 corse/giorno):
--   09:30  dep  hotel → Piazza Marina
--   12:00  arr  Piazza Marina → hotel
--   12:40  arr  Piazza Marina → hotel
--   16:00  dep  hotel → Piazza Marina
--   18:15  arr  Piazza Marina → hotel
--   18:50  arr  Piazza Marina → hotel

do $$
declare
  v_tenant uuid  := 'd200b89a-64c7-4f8d-a430-95a33b83047a';
  v_hotel  uuid;
  v_date   date  := '2026-04-29';
  v_end    date  := '2026-12-08';
  v_departure_meeting_point text := 'Htl Cristallo';
  v_arrival_meeting_point   text := 'Piazza Marina Casamicciola';

  -- Ogni elemento: orario|direzione  (dep=hotel→piazza, arr=piazza→hotel)
  v_runs   text[] := ARRAY[
    '09:30|dep',
    '12:00|arr',
    '12:40|arr',
    '16:00|dep',
    '18:15|arr',
    '18:50|arr'
  ];
  v_run    text;
  v_time   text;
  v_dir    text;
  v_stype  text;
  v_count  int := 0;
begin

  select id into v_hotel
  from public.hotels
  where tenant_id = v_tenant
    and name ilike '%cristallo%'
  order by name
  limit 1;

  if v_hotel is null then
    raise exception '[0167] Hotel Cristallo non trovato – migrazione interrotta.';
  end if;

  raise notice '[0167] Hotel Cristallo id = %', v_hotel;

  -- Rimuove eventuali navette Cristallo già presenti (evita duplicati)
  delete from public.services
  where tenant_id = v_tenant
    and hotel_id   = v_hotel
    and booking_service_kind = 'navetta'
    and date between v_date and v_end;

  -- Reinserisce tutte le corse
  while v_date <= v_end loop
    if extract(dow from v_date) between 1 and 6 then

      foreach v_run in array v_runs loop
        v_time := split_part(v_run, '|', 1);
        v_dir  := split_part(v_run, '|', 2);

        if v_dir = 'dep' then
          v_stype := 'departure';
        else
          v_stype := 'arrival';
        end if;

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
          v_tenant, v_date, v_time::time,
          'transfer'::service_type, v_stype::service_direction,
          'Hotel Cristallo', 1,
          v_hotel, 'Navetta',
          'navetta',
          case
            when v_stype = 'departure' then v_departure_meeting_point
            else v_arrival_meeting_point
          end,
          '', '',
          'new', false
        );

        v_count := v_count + 1;
      end loop;
    end if;

    v_date := v_date + 1;
  end loop;

  raise notice '[0167] Inseriti % servizi navetta Cristallo (lun-sab % → %)', v_count, '2026-04-29', v_end;
end $$;
