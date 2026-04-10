-- Aggiunge pickup_time a tenant_bus_line_stops
alter table public.tenant_bus_line_stops
  add column if not exists pickup_time text null; -- formato HH:MM

-- Ricrea la view ops_bus_allocation_details includendo pickup_time e pickup_note dalla fermata
drop view if exists public.ops_bus_allocation_details;

create view public.ops_bus_allocation_details as
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
  u.driver_name,
  u.driver_phone,
  a.stop_id,
  a.stop_name,
  s2.city as stop_city,
  s2.pickup_note as stop_pickup_note,
  s2.pickup_time as stop_pickup_time,
  a.direction,
  a.pax_assigned,
  s.date as service_date,
  s.time as service_time,
  s.customer_name,
  s.customer_first_name,
  s.customer_last_name,
  s.phone as customer_phone,
  s.hotel_id,
  h.name as hotel_name,
  a.notes,
  a.created_at,
  a.tenant_id
from public.tenant_bus_allocations a
join public.tenant_bus_lines l on l.id = a.bus_line_id
join public.tenant_bus_units u on u.id = a.bus_unit_id
join public.services s on s.id = a.service_id
left join public.hotels h on h.id = s.hotel_id
left join public.tenant_bus_line_stops s2 on s2.id = a.stop_id;

-- Popola pickup_time per tutte le linee dal PDF "Ischia con Bus 2026"

-- LINEA 1 ITALIA
update public.tenant_bus_line_stops set pickup_time = '05:00' where stop_name ilike 'brescia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:45' where stop_name ilike 'bergamo' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:30' where stop_name ilike 'milano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:45' where stop_name ilike 'melegnano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:00' where stop_name ilike 'lodi' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:30' where stop_name ilike 'piacenza' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:50' where stop_name ilike 'fidenza' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:00' where stop_name ilike 'parma' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:30' where stop_name ilike 'reggio emilia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:45' where stop_name ilike 'modena' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '09:15' where stop_name ilike 'bologna' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '10:40' where stop_name ilike 'firenze' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:00' where stop_name ilike 'incisa' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:15' where stop_name ilike 'valdarno' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:40' where stop_name ilike 'arezzo' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:55' where stop_name ilike 'monte san savino' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '12:10' where stop_name ilike 'valdichiana' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '12:30' where stop_name ilike 'chiusi%' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '12:45' where stop_name ilike 'fabro' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '13:00' where stop_name ilike 'orvieto' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '13:30' where stop_name ilike 'orte' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '14:30' where stop_name ilike 'roma' and (pickup_time is null or pickup_time = '');

-- LINEA 2 PIEMONTE
update public.tenant_bus_line_stops set pickup_time = '04:15' where stop_name ilike 'ivrea' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:40' where stop_name ilike 'biella' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:55' where stop_name ilike 'cavaglia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:00' where stop_name ilike 'vercelli%' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:15' where stop_name ilike 'torino' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:25' where stop_name ilike 'villanova' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:40' where stop_name ilike 'novara' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:45' where stop_name ilike 'asti' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:55' where stop_name ilike 'santhia%' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:00' where stop_name ilike 'alessandria' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:10' where stop_name ilike 'tortona' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:20' where stop_name ilike 'voghera' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:30' where stop_name ilike 'casteggio' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:45' where stop_name ilike 'castel san giovanni' and (pickup_time is null or pickup_time = '');

-- LINEA 3 LIGURIA
update public.tenant_bus_line_stops set pickup_time = '06:20' where stop_name ilike 'genova' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:40' where stop_name ilike 'chiavari' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:20' where stop_name ilike 'la spezia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:30' where stop_name ilike 'massa' and (pickup_time is null or pickup_time = '');

-- LINEA 4 LOMBARDIA
update public.tenant_bus_line_stops set pickup_time = '05:00' where stop_name ilike 'varese' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:20' where stop_name ilike 'gallarate' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:30' where stop_name ilike 'busto arsizio' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:40' where stop_name ilike 'legnano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:50' where stop_name ilike 'lainate' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:05' where stop_name ilike 'rho' and (pickup_time is null or pickup_time = '');

-- LINEA 5 LOMBARDIA 2
update public.tenant_bus_line_stops set pickup_time = '04:20' where stop_name ilike 'lecco' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:45' where stop_name ilike 'erba' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:10' where stop_name ilike 'como' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:30' where stop_name ilike 'seregno' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:50' where stop_name ilike 'monza' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:00' where stop_name ilike 'sesto san giovanni' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:00' where stop_name ilike 'cremona' and (pickup_time is null or pickup_time = '');

-- LINEA 6 VENETO
update public.tenant_bus_line_stops set pickup_time = '03:30' where stop_name ilike 'feltre' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:00' where stop_name ilike 'belluno' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:35' where stop_name ilike 'vittorio veneto' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:00' where stop_name ilike 'conegliano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:20' where stop_name ilike 'treviso' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:55' where stop_name ilike 'mestre' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:20' where stop_name ilike 'vicenza' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:20' where stop_name ilike 'rovigo' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:30' where stop_name ilike 'padova' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:00' where stop_name ilike 'ferrara' and (pickup_time is null or pickup_time = '');

-- LINEA 7 CENTRO
update public.tenant_bus_line_stops set pickup_time = '04:00' where stop_name ilike 'citt_ di castello' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:15' where stop_name ilike 'umbertide' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:30' where stop_name ilike 'perugia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:40' where stop_name ilike 'ponte san giovanni' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '04:50' where (stop_name ilike 's. maria degli angeli' or stop_name ilike 'santa maria degli angeli') and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:15' where stop_name ilike 'foligno' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:45' where stop_name ilike 'spoleto' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:00' where stop_name ilike 'viterbo' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:10' where stop_name ilike 'amelia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:10' where stop_name ilike 'orte' and (pickup_time is null or pickup_time = '');

-- LINEA 8 CENTRO
update public.tenant_bus_line_stops set pickup_time = '07:45' where stop_name ilike 'roma tiburtina' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:15' where stop_name ilike 'roma anagnina' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:45' where stop_name ilike 'valmontone' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '10:30' where stop_name ilike 'cassino' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:10' where stop_name ilike 'caserta' and (pickup_time is null or pickup_time = '');

-- LINEA 9 TRENTINO
update public.tenant_bus_line_stops set pickup_time = '04:25' where stop_name ilike 'merano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:00' where stop_name ilike 'bolzano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:20' where (stop_name ilike 'san michele all%adige' or stop_name ilike 'san michele all''adige') and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:35' where stop_name ilike 'trento' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:05' where stop_name ilike 'rovereto' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:20' where (stop_name ilike 'ala%avio' or stop_name ilike 'ala/avio') and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:35' where stop_name ilike 'affi' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:45' where stop_name ilike 'verona' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:30' where stop_name ilike 'mantova' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:00' where stop_name ilike 'carpi' and (pickup_time is null or pickup_time = '');

-- LINEA 10 TOSCANA
update public.tenant_bus_line_stops set pickup_time = '08:00' where stop_name ilike 'viareggio' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:15' where stop_name ilike 'livorno' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:35' where stop_name ilike 'pisa' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:55' where stop_name ilike 'lucca' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '09:15' where stop_name ilike 'montecatini' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '09:30' where stop_name ilike 'pistoia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '09:50' where stop_name ilike 'prato' and (pickup_time is null or pickup_time = '');

-- LINEA 11 ADRIATICA
update public.tenant_bus_line_stops set pickup_time = '04:45' where stop_name ilike 'cesena' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:10' where stop_name ilike 'rimini' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:25' where stop_name ilike 'cattolica' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:40' where stop_name ilike 'pesaro' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '05:50' where stop_name ilike 'fano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:20' where stop_name ilike 'senigallia' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:35' where (stop_name ilike 'iesi' or stop_name ilike 'jesi') and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '06:50' where stop_name ilike 'ancona' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '07:20' where stop_name ilike 'civitanova%' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:10' where (stop_name ilike 'san benedetto%' or stop_name ilike 's. benedetto%') and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '08:30' where stop_name ilike 'giulianova' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '09:00' where stop_name ilike 'pescara%' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '09:30' where stop_name ilike 'sulmona' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '10:00' where stop_name ilike 'avezzano' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:00' where stop_name ilike 'sora' and (pickup_time is null or pickup_time = '');
update public.tenant_bus_line_stops set pickup_time = '11:30' where stop_name ilike 'cassino' and pickup_time is null;
