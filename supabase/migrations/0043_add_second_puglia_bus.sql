with line_italia as (
  select id, tenant_id
  from public.tenant_bus_lines
  where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid
    and code = 'ITALIA'
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
  'ITALIA PUGLIA 2',
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
    and u.label = 'ITALIA PUGLIA 2'
);
