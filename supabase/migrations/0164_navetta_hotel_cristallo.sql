-- Migration 0164: Navetta Hotel Cristallo ↔ Piazza Marina (Casamicciola)
-- Servizio fisso lunedì-sabato, 29 apr 2026 – 08 dic 2026.
-- 6 corse/giorno con direzione definita da orario:
--   09:30  htl cristallo → p.zza marina
--   12:00  p.zza marina  → htl cristallo
--   12:40  p.zza marina  → htl cristallo
--   16:00  htl cristallo → p.zza marina
--   18:15  p.zza marina  → htl cristallo
--   18:50  p.zza marina  → htl cristallo
-- Nota: 'navetta' è già stato aggiunto al constraint in migrazione 0163.

do $$
declare
  v_tenant uuid  := 'd200b89a-64c7-4f8d-a430-95a33b83047a';
  v_hotel  uuid;
  v_date   date  := '2026-04-29';
  v_end    date  := '2026-12-08';
  v_piazza text  := 'Piazza Marina, Casamicciola';

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
begin

  select id into v_hotel
  from public.hotels
  where tenant_id = v_tenant
    and name ilike '%cristallo%'
  order by name
  limit 1;

  if v_hotel is null then
    raise notice '[0164] Hotel Cristallo non trovato – migrazione saltata.';
    return;
  end if;

  raise notice '[0164] Hotel Cristallo id = %', v_hotel;

  while v_date <= v_end loop
    if extract(dow from v_date) between 1 and 6 then

      foreach v_run in array v_runs loop
        v_time := split_part(v_run, '|', 1);
        v_dir  := split_part(v_run, '|', 2);

        -- dep = hotel → piazza (departure), arr = piazza → hotel (arrival)
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
          v_piazza,
          '', '',
          'new', false
        );

      end loop;
    end if;

    v_date := v_date + 1;
  end loop;

  raise notice '[0164] Migrazione completata fino al %', v_end;
end $$;
