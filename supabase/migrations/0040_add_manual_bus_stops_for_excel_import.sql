with selected_lines as (
  select id, code, tenant_id
  from public.tenant_bus_lines
  where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid
    and code in ('CENTRO', 'ADRIATICA')
),
desired_stops as (
  select *
  from (
    values
      ('CENTRO', 1, 'CITTA DI CASTELLO', null, false),
      ('CENTRO', 2, 'UMBERTIDE', null, false),
      ('CENTRO', 3, 'PERUGIA', null, false),
      ('CENTRO', 4, 'PONTE SAN GIOVANNI', null, false),
      ('CENTRO', 5, 'SANTA MARIA DEGLI ANGELI', null, false),
      ('CENTRO', 6, 'FOLIGNO', null, false),
      ('CENTRO', 7, 'SPOLETO', null, false),
      ('CENTRO', 8, 'TERNI', 'Import Excel cliente - fermata manuale da confermare', true),
      ('CENTRO', 9, 'VITERBO', null, false),
      ('CENTRO', 10, 'AMELIA', null, false),
      ('CENTRO', 11, 'ORTE', null, false),
      ('CENTRO', 12, 'PONZANO', 'Import Excel cliente - fermata manuale da confermare', true),
      ('CENTRO', 13, 'ROMA TIBURTINA', null, false),
      ('CENTRO', 14, 'GUIDONIA', 'Import Excel cliente - fermata manuale da confermare', true),
      ('CENTRO', 15, 'ROMA ANAGNINA', null, false),
      ('CENTRO', 16, 'VALMONTONE', null, false),
      ('CENTRO', 17, 'COLLEFERRO', 'Import Excel cliente - fermata manuale da confermare', true),
      ('CENTRO', 18, 'CASSINO', null, false),
      ('CENTRO', 19, 'CASERTA', null, false),
      ('ADRIATICA', 1, 'RAVENNA', 'Import Excel cliente - fermata manuale da confermare', true),
      ('ADRIATICA', 2, 'CESENA', null, false),
      ('ADRIATICA', 3, 'RIMINI', null, false),
      ('ADRIATICA', 4, 'CATTOLICA', null, false),
      ('ADRIATICA', 5, 'PESARO', null, false),
      ('ADRIATICA', 6, 'FANO', null, false),
      ('ADRIATICA', 7, 'SENIGALLIA', null, false),
      ('ADRIATICA', 8, 'IESI', null, false),
      ('ADRIATICA', 9, 'ANCONA', null, false),
      ('ADRIATICA', 10, 'CIVITANOVA MARCHE', null, false),
      ('ADRIATICA', 11, 'SAN BENEDETTO DEL TRONTO', null, false),
      ('ADRIATICA', 12, 'GIULIANOVA', null, false),
      ('ADRIATICA', 13, 'PESCARA VILLA NOVA', null, false),
      ('ADRIATICA', 14, 'SULMONA', null, false),
      ('ADRIATICA', 15, 'AVEZZANO', null, false),
      ('ADRIATICA', 16, 'SORA', null, false),
      ('ADRIATICA', 17, 'CASSINO', null, false)
  ) as t(line_code, arrival_order, stop_name, pickup_note, is_manual)
),
line_counts as (
  select line_code, count(*) as total_stops
  from desired_stops
  group by line_code
),
arrival_desired as (
  select
    l.tenant_id,
    l.id as bus_line_id,
    d.line_code,
    'arrival'::public.service_direction as direction,
    d.stop_name,
    d.stop_name as city,
    d.pickup_note,
    d.arrival_order as stop_order,
    d.arrival_order as order_index,
    d.is_manual
  from desired_stops d
  join selected_lines l on l.code = d.line_code
),
departure_desired as (
  select
    l.tenant_id,
    l.id as bus_line_id,
    d.line_code,
    'departure'::public.service_direction as direction,
    d.stop_name,
    d.stop_name as city,
    d.pickup_note,
    (c.total_stops - d.arrival_order + 1) as stop_order,
    (c.total_stops - d.arrival_order + 1) as order_index,
    d.is_manual
  from desired_stops d
  join selected_lines l on l.code = d.line_code
  join line_counts c on c.line_code = d.line_code
),
all_desired as (
  select * from arrival_desired
  union all
  select * from departure_desired
),
inserted_missing as (
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
    d.tenant_id,
    d.bus_line_id,
    d.direction,
    d.stop_name,
    d.city,
    d.pickup_note,
    d.stop_order,
    d.order_index,
    null,
    null,
    d.is_manual,
    true
  from all_desired d
  where not exists (
    select 1
    from public.tenant_bus_line_stops s
    where s.tenant_id = d.tenant_id
      and s.bus_line_id = d.bus_line_id
      and s.direction = d.direction
      and s.stop_name = d.stop_name
  )
  returning id
)
update public.tenant_bus_line_stops s
set
  city = d.city,
  pickup_note = coalesce(d.pickup_note, s.pickup_note),
  stop_order = d.stop_order,
  order_index = d.order_index,
  updated_at = now()
from all_desired d
where s.tenant_id = d.tenant_id
  and s.bus_line_id = d.bus_line_id
  and s.direction = d.direction
  and s.stop_name = d.stop_name;
