-- Aggiunge fermate mancanti emerse dall'import Excel:
-- NUVOLENTO, NUVOLERA (Linea Italia - area Brescia)
-- SCHIO, PIOVENE ROCCHETTE, CHIUPPANO (Linea Veneto - area Vicenza nord)
-- ALBA ADRIATICA (Linea Adriatica - costa abruzzese)

with tenant_ref as (
  select 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid as id
),
lines as (
  select id, code
  from public.tenant_bus_lines
  where tenant_id = (select id from tenant_ref)
    and code in ('ITALIA', 'VENETO', 'ADRIATICA')
),
new_stops as (
  select * from (values
    -- Linea Italia: comuni tra Brescia e Milano (bus passa prima di Brescia)
    ('ITALIA', 'arrival'::public.service_direction,   'NUVOLENTO',         'NUVOLENTO',         null::text),
    ('ITALIA', 'departure'::public.service_direction, 'NUVOLENTO',         'NUVOLENTO',         null::text),
    ('ITALIA', 'arrival'::public.service_direction,   'NUVOLERA',          'NUVOLERA',          null::text),
    ('ITALIA', 'departure'::public.service_direction, 'NUVOLERA',          'NUVOLERA',          null::text),
    -- Linea Veneto: comuni nord di Vicenza (Schio, Piovene, Chiuppano)
    ('VENETO', 'arrival'::public.service_direction,   'SCHIO',             'SCHIO',             'Piazza Statuto'),
    ('VENETO', 'departure'::public.service_direction, 'SCHIO',             'SCHIO',             'Piazza Statuto'),
    ('VENETO', 'arrival'::public.service_direction,   'PIOVENE ROCCHETTE', 'PIOVENE ROCCHETTE', 'Via Caltrano'),
    ('VENETO', 'departure'::public.service_direction, 'PIOVENE ROCCHETTE', 'PIOVENE ROCCHETTE', 'Via Caltrano'),
    ('VENETO', 'arrival'::public.service_direction,   'CHIUPPANO',         'CHIUPPANO',         'Via Monte Pau'),
    ('VENETO', 'departure'::public.service_direction, 'CHIUPPANO',         'CHIUPPANO',         'Via Monte Pau'),
    -- Linea Adriatica: Alba Adriatica (tra Giulianova e Pescara)
    ('ADRIATICA', 'arrival'::public.service_direction,   'ALBA ADRIATICA', 'ALBA ADRIATICA', 'Casello Autostradale'),
    ('ADRIATICA', 'departure'::public.service_direction, 'ALBA ADRIATICA', 'ALBA ADRIATICA', 'Casello Autostradale')
  ) as t(line_code, direction, stop_name, city, pickup_note)
),
max_orders as (
  select l.id as bus_line_id, s.direction, max(s.stop_order) as max_order
  from public.tenant_bus_line_stops s
  join lines l on l.id = s.bus_line_id
  group by l.id, s.direction
),
to_insert as (
  select
    (select id from tenant_ref) as tenant_id,
    l.id as bus_line_id,
    n.direction,
    n.stop_name,
    n.city,
    n.pickup_note,
    coalesce(m.max_order, 0) +
      row_number() over (partition by l.id, n.direction order by n.stop_name) as stop_order
  from new_stops n
  join lines l on l.code = n.line_code
  left join max_orders m on m.bus_line_id = l.id and m.direction = n.direction
  where not exists (
    select 1 from public.tenant_bus_line_stops existing
    where existing.bus_line_id = l.id
      and existing.direction = n.direction
      and lower(existing.stop_name) = lower(n.stop_name)
  )
)
insert into public.tenant_bus_line_stops (
  tenant_id, bus_line_id, direction, stop_name, city, pickup_note,
  stop_order, order_index, active
)
select tenant_id, bus_line_id, direction, stop_name, city, pickup_note,
  stop_order, stop_order, true
from to_insert;
