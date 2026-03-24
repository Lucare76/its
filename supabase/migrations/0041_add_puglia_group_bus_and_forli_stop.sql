with selected_lines as (
  select id, code, tenant_id
  from public.tenant_bus_lines
  where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid
    and code in ('ITALIA', 'ADRIATICA')
),
desired_stops as (
  select *
  from (
    values
      ('ITALIA', 'arrival'::public.service_direction, 25, 'SAN PAOLO CIVITATE', 'Import Excel cliente - gruppo Puglia dedicato', true),
      ('ITALIA', 'arrival'::public.service_direction, 26, 'GIOVINAZZO', 'Import Excel cliente - gruppo Puglia dedicato', true),
      ('ITALIA', 'arrival'::public.service_direction, 27, 'BARI', 'Import Excel cliente - gruppo Puglia dedicato', true),
      ('ITALIA', 'departure'::public.service_direction, 3, 'SAN PAOLO CIVITATE', 'Import Excel cliente - gruppo Puglia dedicato', true),
      ('ITALIA', 'departure'::public.service_direction, 2, 'GIOVINAZZO', 'Import Excel cliente - gruppo Puglia dedicato', true),
      ('ITALIA', 'departure'::public.service_direction, 1, 'BARI', 'Import Excel cliente - gruppo Puglia dedicato', true),
      ('ADRIATICA', 'arrival'::public.service_direction, 2, 'FORLI', 'Import Excel cliente - fermata manuale prima di Cesena', true),
      ('ADRIATICA', 'departure'::public.service_direction, 17, 'FORLI', 'Import Excel cliente - fermata manuale prima di Cesena', true)
  ) as t(line_code, direction, stop_order, stop_name, pickup_note, is_manual)
),
insert_missing_stops as (
  insert into public.tenant_bus_line_stops (
    tenant_id,
    bus_line_id,
    direction,
    stop_name,
    city,
    pickup_note,
    stop_order,
    order_index,
    lat,
    lng,
    is_manual,
    active
  )
  select
    l.tenant_id,
    l.id,
    d.direction,
    d.stop_name,
    d.stop_name,
    d.pickup_note,
    d.stop_order,
    d.stop_order,
    null,
    null,
    d.is_manual,
    true
  from desired_stops d
  join selected_lines l on l.code = d.line_code
  where not exists (
    select 1
    from public.tenant_bus_line_stops s
    where s.tenant_id = l.tenant_id
      and s.bus_line_id = l.id
      and s.direction = d.direction
      and s.stop_name = d.stop_name
  )
  returning id
),
shift_adriatica_arrival as (
  update public.tenant_bus_line_stops s
  set
    stop_order = case
      when s.stop_name = 'RAVENNA' then 1
      when s.stop_name = 'FORLI' then 2
      when s.stop_name = 'CESENA' then 3
      when s.stop_name = 'RIMINI' then 4
      when s.stop_name = 'CATTOLICA' then 5
      when s.stop_name = 'PESARO' then 6
      when s.stop_name = 'FANO' then 7
      when s.stop_name = 'SENIGALLIA' then 8
      when s.stop_name = 'IESI' then 9
      when s.stop_name = 'ANCONA' then 10
      when s.stop_name = 'CIVITANOVA MARCHE' then 11
      when s.stop_name = 'SAN BENEDETTO DEL TRONTO' then 12
      when s.stop_name = 'GIULIANOVA' then 13
      when s.stop_name = 'PESCARA VILLA NOVA' then 14
      when s.stop_name = 'SULMONA' then 15
      when s.stop_name = 'AVEZZANO' then 16
      when s.stop_name = 'SORA' then 17
      when s.stop_name = 'CASSINO' then 18
      else s.stop_order
    end,
    order_index = case
      when s.stop_name = 'RAVENNA' then 1
      when s.stop_name = 'FORLI' then 2
      when s.stop_name = 'CESENA' then 3
      when s.stop_name = 'RIMINI' then 4
      when s.stop_name = 'CATTOLICA' then 5
      when s.stop_name = 'PESARO' then 6
      when s.stop_name = 'FANO' then 7
      when s.stop_name = 'SENIGALLIA' then 8
      when s.stop_name = 'IESI' then 9
      when s.stop_name = 'ANCONA' then 10
      when s.stop_name = 'CIVITANOVA MARCHE' then 11
      when s.stop_name = 'SAN BENEDETTO DEL TRONTO' then 12
      when s.stop_name = 'GIULIANOVA' then 13
      when s.stop_name = 'PESCARA VILLA NOVA' then 14
      when s.stop_name = 'SULMONA' then 15
      when s.stop_name = 'AVEZZANO' then 16
      when s.stop_name = 'SORA' then 17
      when s.stop_name = 'CASSINO' then 18
      else s.order_index
    end,
    updated_at = now()
  from selected_lines l
  where l.code = 'ADRIATICA'
    and s.tenant_id = l.tenant_id
    and s.bus_line_id = l.id
    and s.direction = 'arrival'
),
shift_adriatica_departure as (
  update public.tenant_bus_line_stops s
  set
    stop_order = case
      when s.stop_name = 'CASSINO' then 1
      when s.stop_name = 'SORA' then 2
      when s.stop_name = 'AVEZZANO' then 3
      when s.stop_name = 'SULMONA' then 4
      when s.stop_name = 'PESCARA VILLA NOVA' then 5
      when s.stop_name = 'GIULIANOVA' then 6
      when s.stop_name = 'SAN BENEDETTO DEL TRONTO' then 7
      when s.stop_name = 'CIVITANOVA MARCHE' then 8
      when s.stop_name = 'ANCONA' then 9
      when s.stop_name = 'IESI' then 10
      when s.stop_name = 'SENIGALLIA' then 11
      when s.stop_name = 'FANO' then 12
      when s.stop_name = 'PESARO' then 13
      when s.stop_name = 'CATTOLICA' then 14
      when s.stop_name = 'RIMINI' then 15
      when s.stop_name = 'CESENA' then 16
      when s.stop_name = 'FORLI' then 17
      when s.stop_name = 'RAVENNA' then 18
      else s.stop_order
    end,
    order_index = case
      when s.stop_name = 'CASSINO' then 1
      when s.stop_name = 'SORA' then 2
      when s.stop_name = 'AVEZZANO' then 3
      when s.stop_name = 'SULMONA' then 4
      when s.stop_name = 'PESCARA VILLA NOVA' then 5
      when s.stop_name = 'GIULIANOVA' then 6
      when s.stop_name = 'SAN BENEDETTO DEL TRONTO' then 7
      when s.stop_name = 'CIVITANOVA MARCHE' then 8
      when s.stop_name = 'ANCONA' then 9
      when s.stop_name = 'IESI' then 10
      when s.stop_name = 'SENIGALLIA' then 11
      when s.stop_name = 'FANO' then 12
      when s.stop_name = 'PESARO' then 13
      when s.stop_name = 'CATTOLICA' then 14
      when s.stop_name = 'RIMINI' then 15
      when s.stop_name = 'CESENA' then 16
      when s.stop_name = 'FORLI' then 17
      when s.stop_name = 'RAVENNA' then 18
      else s.order_index
    end,
    updated_at = now()
  from selected_lines l
  where l.code = 'ADRIATICA'
    and s.tenant_id = l.tenant_id
    and s.bus_line_id = l.id
    and s.direction = 'departure'
),
upsert_puglia_notes as (
  update public.tenant_bus_line_stops s
  set
    pickup_note = 'Import Excel cliente - gruppo Puglia dedicato',
    stop_order = d.stop_order,
    order_index = d.stop_order,
    updated_at = now()
  from desired_stops d
  join selected_lines l on l.code = d.line_code
  where d.line_code = 'ITALIA'
    and s.tenant_id = l.tenant_id
    and s.bus_line_id = l.id
    and s.direction = d.direction
    and s.stop_name = d.stop_name
  returning s.id
),
line_italia as (
  select id, tenant_id
  from selected_lines
  where code = 'ITALIA'
),
next_sort_order as (
  select
    l.id as bus_line_id,
    l.tenant_id,
    coalesce(max(u.sort_order), 0) as max_sort_order
  from line_italia l
  left join public.tenant_bus_units u
    on u.tenant_id = l.tenant_id
   and u.bus_line_id = l.id
  group by l.id, l.tenant_id
)
insert into public.tenant_bus_units (
  tenant_id,
  bus_line_id,
  label,
  capacity,
  low_seat_threshold,
  minimum_passengers,
  status,
  manual_close,
  close_reason,
  sort_order,
  active
)
select
  n.tenant_id,
  n.bus_line_id,
  'ITALIA PUGLIA',
  54,
  5,
  null,
  'open',
  false,
  null,
  n.max_sort_order + 1,
  true
from next_sort_order n
where not exists (
  select 1
  from public.tenant_bus_units u
  where u.tenant_id = n.tenant_id
    and u.bus_line_id = n.bus_line_id
    and u.label = 'ITALIA PUGLIA'
);
