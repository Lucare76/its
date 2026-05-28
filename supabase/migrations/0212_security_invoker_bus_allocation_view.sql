drop view if exists public.ops_bus_allocation_details;

create view public.ops_bus_allocation_details
with (security_invoker = true) as
select
  a.id as allocation_id,
  coalesce(a.root_allocation_id, a.id) as root_allocation_id,
  a.split_from_allocation_id,
  a.service_id,
  a.bus_line_id,
  l.code as line_code,
  l.name as line_name,
  l.family_code,
  l.family_name,
  a.bus_unit_id,
  u.label as bus_label,
  u.driver_name_outbound as driver_name,
  u.driver_phone_outbound as driver_phone,
  a.stop_id,
  a.stop_name,
  s2.city as stop_city,
  s2.pickup_note as stop_pickup_note,
  s2.pickup_time as stop_pickup_time,
  a.direction,
  a.pax_assigned,
  s.date as service_date,
  s.time as service_time,
  coalesce(
    nullif(trim(concat_ws(' ', s.customer_first_name, s.customer_last_name)), ''),
    nullif(trim(s.customer_name), ''),
    'Cliente N/D'
  ) as customer_name,
  s.phone as customer_phone,
  s.hotel_id,
  coalesce(
    h.name,
    s.meeting_point,
    nullif(trim(split_part(split_part(a.notes, 'Hotel: ', 2), ' ·', 1)), '')
  ) as hotel_name,
  s.billing_party_name as agency_name,
  a.notes,
  a.created_at,
  a.tenant_id,
  case lower(trim(l.family_code))
    when 'italia' then hpt.pickup_time_linea_italia
    when 'centro' then hpt.pickup_time_linea_centro
    when 'adriatica' then hpt.pickup_time_linea_adriatica
    else null
  end as hotel_pickup_time
from public.tenant_bus_allocations a
join public.tenant_bus_lines l on l.id = a.bus_line_id
join public.tenant_bus_units u on u.id = a.bus_unit_id
join public.services s on s.id = a.service_id
left join public.hotels h on h.id = s.hotel_id
left join public.tenant_bus_line_stops s2 on s2.id = a.stop_id
left join public.hotel_pickup_times hpt
  on upper(trim(hpt.hotel_name)) = upper(trim(coalesce(
    h.name,
    s.meeting_point,
    nullif(trim(split_part(split_part(a.notes, 'Hotel: ', 2), ' ·', 1)), '')
  )));
