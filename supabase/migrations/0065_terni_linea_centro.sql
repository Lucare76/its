-- Aggiunge la fermata TERNI - Terminal ATC alla Linea Centro (family_code = 'CENTRO')
-- Posizione geografica: tra Spoleto e Viterbo/Amelia (Umbria sud)
-- Orario: 05:52 (tra Spoleto 05:45 e Viterbo 06:00)

do $$
declare
  v_line_id uuid;
  v_tenant_id uuid;
  v_spoleto_arr integer;
  v_spoleto_dep integer;
begin
  for v_line_id, v_tenant_id in
    select id, tenant_id from public.tenant_bus_lines
    where family_code = 'CENTRO'
  loop

    -- ── ANDATA ──────────────────────────────────────────────────────────────
    select stop_order into v_spoleto_arr
    from public.tenant_bus_line_stops
    where bus_line_id = v_line_id
      and direction = 'arrival'
      and upper(stop_name) like 'SPOLETO%'
    limit 1;

    -- Sposta in avanti le fermate dopo Spoleto per fare spazio a Terni
    if v_spoleto_arr is not null then
      update public.tenant_bus_line_stops
      set stop_order = stop_order + 1,
          order_index = order_index + 1
      where bus_line_id = v_line_id
        and direction = 'arrival'
        and stop_order > v_spoleto_arr;
    end if;

    -- Inserisce Terni solo se non esiste già
    insert into public.tenant_bus_line_stops
      (tenant_id, bus_line_id, direction, stop_name, city, pickup_note, pickup_time,
       stop_order, order_index, is_manual, active)
    select
      v_tenant_id, v_line_id, 'arrival', 'TERNI', 'Terni', 'Terminal ATC', '05:52',
      coalesce(v_spoleto_arr, 0) + 1, coalesce(v_spoleto_arr, 0) + 1, false, true
    where not exists (
      select 1 from public.tenant_bus_line_stops
      where bus_line_id = v_line_id and direction = 'arrival' and upper(stop_name) = 'TERNI'
    );

    -- ── RITORNO ─────────────────────────────────────────────────────────────
    select stop_order into v_spoleto_dep
    from public.tenant_bus_line_stops
    where bus_line_id = v_line_id
      and direction = 'departure'
      and upper(stop_name) like 'SPOLETO%'
    limit 1;

    if v_spoleto_dep is not null then
      update public.tenant_bus_line_stops
      set stop_order = stop_order + 1,
          order_index = order_index + 1
      where bus_line_id = v_line_id
        and direction = 'departure'
        and stop_order > v_spoleto_dep;
    end if;

    insert into public.tenant_bus_line_stops
      (tenant_id, bus_line_id, direction, stop_name, city, pickup_note, pickup_time,
       stop_order, order_index, is_manual, active)
    select
      v_tenant_id, v_line_id, 'departure', 'TERNI', 'Terni', 'Terminal ATC', '05:52',
      coalesce(v_spoleto_dep, 0) + 1, coalesce(v_spoleto_dep, 0) + 1, false, true
    where not exists (
      select 1 from public.tenant_bus_line_stops
      where bus_line_id = v_line_id and direction = 'departure' and upper(stop_name) = 'TERNI'
    );

  end loop;
end;
$$;
