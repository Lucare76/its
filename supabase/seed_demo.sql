-- Ischia Transfer Beta - Demo seed for Supabase SQL Editor
-- Run this file after supabase/bootstrap.sql
-- Status mapping used by the app:
-- new = unassigned, assigned = assigned, partito/arrivato = in_progress, completato = completed

insert into public.tenants (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Demo Ischia')
on conflict (id) do update set name = excluded.name;

with zones as (
  select unnest(array[
    'Ischia Porto',
    'Ischia Ponte',
    'Casamicciola',
    'Lacco Ameno',
    'Forio',
    'Barano',
    'Serrara Fontana'
  ]) as zone
),
base_names as (
  select unnest(array[
    'Grand Hotel Royal', 'Hotel Terme Excelsior', 'Villa Mediterranea', 'Hotel Mare Blu',
    'Resort Bellavista', 'Hotel Panorama', 'Parco Aurora', 'Hotel San Montano',
    'Hotel Belvedere', 'Hotel Eden Park', 'Boutique Hotel Corallo', 'Hotel Le Querce',
    'Hotel Continental', 'Hotel Central Park', 'Hotel La Pergola', 'Hotel Castiglione',
    'Hotel Miramare', 'Hotel Don Pedro', 'Hotel Sirena', 'Hotel Villa Durrueli'
  ]) as base_name
),
numbers as (
  select generate_series(1, 80) as n
)
insert into public.hotels (id, tenant_id, name, address, lat, lng, zone)
select
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as id,
  '11111111-1111-1111-1111-111111111111'::uuid as tenant_id,
  (select base_name from base_names offset ((n - 1) % 20) limit 1) || ' ' || (select zone from zones offset ((n - 1) % 7) limit 1),
  'Via Demo ' || (20 + n) || ', ' || (select zone from zones offset ((n - 1) % 7) limit 1),
  40.70 + ((n % 16) * 0.005),
  13.83 + ((n % 14) * 0.009),
  (select zone from zones offset ((n - 1) % 7) limit 1)
from numbers
on conflict (id) do update
set
  name = excluded.name,
  address = excluded.address,
  lat = excluded.lat,
  lng = excluded.lng,
  zone = excluded.zone;

with vessels as (
  select unnest(array['Caremar', 'Alilauro', 'Medmar']) as vessel
),
first_names as (
  select unnest(array[
    'Luca','Marco','Giulia','Francesca','Alessandro','Chiara','Davide','Sara',
    'Matteo','Elena','Andrea','Valentina','Roberto','Martina','Paolo','Federica',
    'Stefano','Laura','Simone','Anna'
  ]) as first_name
),
last_names as (
  select unnest(array[
    'Rossi','Esposito','Romano','Bianchi','Ricci','Marino','Greco','Bruno',
    'Gallo','Conti','Costa','Mancini','Lombardi','Moretti','Barbieri','Giordano',
    'Ferrara','De Luca','Rinaldi','Caruso'
  ]) as last_name
),
numbers as (
  select generate_series(1, 40) as n
)
insert into public.services (
  id, tenant_id, date, time, service_type, direction, vessel, pax, hotel_id, customer_name, phone, notes,
  tour_name, capacity, meeting_point, stops, bus_plate, status
)
select
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  current_date,
  make_time(7 + ((n - 1) % 14), case when n % 2 = 0 then 0 else 30 end, 0),
  case
    when n % 8 = 0 then 'bus_tour'::public.service_type
    else 'transfer'::public.service_type
  end,
  case when n % 2 = 0 then 'departure'::public.service_direction else 'arrival'::public.service_direction end,
  (select vessel from vessels offset ((n - 1) % 3) limit 1),
  1 + ((n - 1) % 6),
  ('20000000-0000-0000-0000-' || lpad(((n - 1) % 80 + 1)::text, 12, '0'))::uuid,
  (select first_name from first_names offset ((n - 1) % 20) limit 1) || ' ' ||
    (select last_name from last_names offset ((n * 3 - 1) % 20) limit 1),
  '+39 3' || lpad((300000000 + n * 137)::text, 9, '0'),
  case when n % 4 = 0 then 'Bagagli extra' else 'Nessuna nota' end,
  case when n % 8 = 0 then 'Tour Ischia Full Day' else null end,
  case when n % 8 = 0 then 18 else null end,
  case when n % 8 = 0 then 'Piazza Marina, Ischia Porto' else null end,
  case when n % 8 = 0 then '["Castello Aragonese","Forio Centro","Sant Angelo"]'::jsonb else '[]'::jsonb end,
  case when n % 8 = 0 then 'IS 900 BT' else null end,
  case
    when n <= 10 then 'new'::public.service_status
    when n <= 20 then 'assigned'::public.service_status
    when n <= 30 then 'partito'::public.service_status
    when n <= 35 then 'arrivato'::public.service_status
    else 'completato'::public.service_status
  end
from numbers
on conflict (id) do update
set
  date = excluded.date,
  time = excluded.time,
  service_type = excluded.service_type,
  direction = excluded.direction,
  vessel = excluded.vessel,
  pax = excluded.pax,
  hotel_id = excluded.hotel_id,
  customer_name = excluded.customer_name,
  phone = excluded.phone,
  notes = excluded.notes,
  tour_name = excluded.tour_name,
  capacity = excluded.capacity,
  meeting_point = excluded.meeting_point,
  stops = excluded.stops,
  bus_plate = excluded.bus_plate,
  status = excluded.status;

insert into public.assignments (id, tenant_id, service_id, driver_user_id, vehicle_label)
select
  ('50000000-0000-0000-0000-' || lpad((n - 10)::text, 12, '0'))::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  null,
  case when n % 2 = 0 then 'VAN' else 'CAR' end
from generate_series(11, 28) as n
on conflict (service_id) do update
set
  vehicle_label = excluded.vehicle_label;

insert into public.status_events (id, tenant_id, service_id, status, at, by_user_id)
select
  ('60000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  case
    when n <= 10 then 'new'::public.service_status
    when n <= 20 then 'assigned'::public.service_status
    when n <= 30 then 'partito'::public.service_status
    when n <= 35 then 'arrivato'::public.service_status
    else 'completato'::public.service_status
  end,
  now() - ((40 - n) || ' minutes')::interval,
  null
from generate_series(1, 24) as n
on conflict (id) do nothing;

insert into public.inbound_emails (id, tenant_id, raw_text, parsed_json, created_at)
values
  (
    '70000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'DATA 2026-03-02 ORA 14:30 NAVE Caremar HOTEL Grand Hotel Royal Ischia Porto PAX 4 NOME Mario Rossi',
    '{"date":"2026-03-02","time":"14:30","vessel":"Caremar","hotel":"Grand Hotel Royal Ischia Porto","pax":4,"customer_name":"Mario Rossi"}'::jsonb,
    now() - interval '4 hours'
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'DATA 2026-03-02 ORA 16:00 NAVE Medmar HOTEL Hotel Mare Blu Forio PAX 2 NOME Giulia Bianchi',
    '{"date":"2026-03-02","time":"16:00","vessel":"Medmar","hotel":"Hotel Mare Blu Forio","pax":2,"customer_name":"Giulia Bianchi"}'::jsonb,
    now() - interval '2 hours'
  ),
  (
    '70000000-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'DATA 2026-03-02 ORA 11:15 NAVE Alilauro HOTEL Hotel Terme Excelsior Ischia Porto PAX 5 NOME Luca Bianchi TEL +39 333 1112233',
    '{"date":"2026-03-02","time":"11:15","vessel":"Alilauro","hotel":"Hotel Terme Excelsior Ischia Porto","pax":5,"customer_name":"Luca Bianchi","phone":"+39 333 1112233","review_status":"needs_review"}'::jsonb,
    now() - interval '1 hour'
  )
on conflict (id) do nothing;

insert into public.services (
  id, tenant_id, inbound_email_id, is_draft, date, time, service_type, direction, vessel, pax, hotel_id, customer_name, phone, notes, status
)
values (
  '30000000-0000-0000-0000-000000009999',
  '11111111-1111-1111-1111-111111111111',
  '70000000-0000-0000-0000-000000000003',
  true,
  current_date,
  '11:15',
  'transfer',
  'arrival',
  'Alilauro',
  5,
  '20000000-0000-0000-0000-000000000001',
  'Luca Bianchi',
  '+39 333 1112233',
  '[needs_review] Draft creato da seed inbound email',
  'new'
)
on conflict (id) do update
set
  inbound_email_id = excluded.inbound_email_id,
  is_draft = excluded.is_draft,
  date = excluded.date,
  time = excluded.time,
  vessel = excluded.vessel,
  pax = excluded.pax,
  hotel_id = excluded.hotel_id,
  customer_name = excluded.customer_name,
  phone = excluded.phone,
  notes = excluded.notes,
  status = excluded.status;
