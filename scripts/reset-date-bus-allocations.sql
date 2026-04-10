-- Svuota TUTTE le allocazioni bus e i relativi servizi del 21 settembre 2025
-- Esegui nel SQL Editor di Supabase

-- 1. Elimina le allocazioni (prima dei servizi per FK)
delete from public.tenant_bus_allocations
where id in (
  select a.id
  from public.tenant_bus_allocations a
  join public.services s on s.id = a.service_id
  where s.date = '2025-09-21'
);

-- 2. Elimina i servizi bus del 21 settembre
delete from public.services
where date = '2025-09-21'
  and (service_type_code = 'bus_line' or booking_service_kind = 'bus_city_hotel');
