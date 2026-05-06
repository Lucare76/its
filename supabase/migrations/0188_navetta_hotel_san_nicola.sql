-- Migration 0188: Navetta Hotel San Nicola ↔ Citara
-- Servizio fisso lunedì-sabato dal 2026-05-01 al 2026-09-30.
--
-- Schedule (12 corse/giorno):
--   09:30  dep  Hotel San Nicola → Citara
--   09:35  arr  Citara → Hotel San Nicola
--   10:00  dep  Hotel San Nicola → Citara
--   10:05  arr  Citara → Hotel San Nicola
--   10:30  dep  Hotel San Nicola → Citara
--   10:35  arr  Citara → Hotel San Nicola
--   18:30  dep  Hotel San Nicola → Citara
--   18:35  arr  Citara → Hotel San Nicola
--   19:00  dep  Hotel San Nicola → Citara
--   19:05  arr  Citara → Hotel San Nicola
--   19:30  dep  Hotel San Nicola → Citara
--   19:35  arr  Citara → Hotel San Nicola

do $$
declare
  v_tenant uuid  := 'd200b89a-64c7-4f8d-a430-95a33b83047a';
  v_hotel  uuid;
  v_date   date  := '2026-05-01';
  v_end    date  := '2026-09-30';
  v_departure_meeting_point text := 'Hotel San Nicola';
  v_arrival_meeting_point   text := 'Citara';
  v_runs   text[] := array[
    '09:30|dep',
    '09:35|arr',
    '10:00|dep',
    '10:05|arr',
    '10:30|dep',
    '10:35|arr',
    '18:30|dep',
    '18:35|arr',
    '19:00|dep',
    '19:05|arr',
    '19:30|dep',
    '19:35|arr'
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
    and name ilike '%san nicola%'
  order by name
  limit 1;

  if v_hotel is null then
    raise exception '[0188] Hotel San Nicola non trovato – migrazione interrotta.';
  end if;

  raise notice '[0188] Hotel San Nicola id = %', v_hotel;

  delete from public.services
  where tenant_id = v_tenant
    and hotel_id = v_hotel
    and booking_service_kind = 'navetta'
    and date between v_date and v_end
    and (
      customer_name = 'Hotel San Nicola'
      or meeting_point in (v_departure_meeting_point, v_arrival_meeting_point)
      or vessel = 'Navetta'
    );

  while v_date <= v_end loop
    if extract(dow from v_date) between 1 and 6 then
    foreach v_run in array v_runs loop
      v_time := split_part(v_run, '|', 1);
      v_dir := split_part(v_run, '|', 2);

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
        'Hotel San Nicola', 1,
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

  raise notice '[0188] Inseriti % servizi navetta Hotel San Nicola (lun-sab % → %)', v_count, '2026-05-01', v_end;
end $$;
