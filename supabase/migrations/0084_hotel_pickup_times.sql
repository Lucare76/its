-- Tabella orari pick-up ritorno per hotel e linea bus
-- Usata nella direzione "departure" (passeggeri lasciano l'isola)
-- Il matching avviene su upper(trim(hotel_name))

create table if not exists public.hotel_pickup_times (
  id                         uuid    primary key default gen_random_uuid(),
  hotel_name                 text    not null,
  comune                     text    not null,
  pickup_time_linea_italia    time    not null,
  pickup_time_linea_centro    time    not null,
  pickup_time_linea_adriatica time    not null
);

-- Indice univoco case-insensitive sul nome hotel
create unique index if not exists hotel_pickup_times_hotel_name_ukey
  on public.hotel_pickup_times (upper(trim(hotel_name)));

-- Seed: 47 hotel di Ischia con orari ritorno per le 3 linee
insert into public.hotel_pickup_times
  (hotel_name, comune, pickup_time_linea_italia, pickup_time_linea_centro, pickup_time_linea_adriatica)
values
  -- FORIO (23 hotel) — partenza nave Casamicciola T 06:20
  ('COLELLA',              'FORIO',          '05:00', '09:50', '09:50'),
  ('LA VILLA',             'FORIO',          '05:00', '09:50', '09:50'),
  ('ROYAL PALM',           'FORIO',          '05:00', '09:50', '09:50'),
  ('PARK LA VILLA',        'FORIO',          '05:00', '09:50', '09:50'),
  ('PUNTA DEL SOLE',       'FORIO',          '05:00', '09:50', '09:50'),
  ('CARLO MAGNO',          'FORIO',          '05:00', '09:50', '09:50'),
  ('ZI CARMELA',           'FORIO',          '05:00', '09:50', '09:50'),
  ('TRITONE',              'FORIO',          '05:00', '09:50', '09:50'),
  ('LORD BYRON',           'FORIO',          '05:00', '09:50', '09:50'),
  ('EDEN PARK',            'FORIO',          '05:00', '09:50', '09:50'),
  ('VILLA TERESA',         'FORIO',          '05:00', '09:50', '09:50'),
  ('RIVA DEL SOLE',        'FORIO',          '05:00', '09:50', '09:50'),
  ('MEDITERRANEO',         'FORIO',          '05:00', '09:50', '09:50'),
  ('JUNIOR VILLAGE',       'FORIO',          '05:00', '09:50', '09:50'),
  ('VILLA MIRALISA',       'FORIO',          '05:00', '09:50', '09:50'),
  ('HOTEL AL BOSCO',       'FORIO',          '05:00', '09:50', '09:50'),
  ('LA GINESTRA',          'FORIO',          '05:00', '09:50', '09:50'),
  ('TRAMONTO D''ORO',      'FORIO',          '05:00', '09:50', '09:50'),
  ('GALIDON',              'FORIO',          '05:00', '09:50', '09:50'),
  ('HOTEL ZARO',           'FORIO',          '05:00', '09:50', '09:50'),
  ('B&B SAN NICOLA',       'FORIO',          '05:00', '09:50', '09:50'),
  ('BAIA DELLE SIRENE',    'FORIO',          '05:00', '09:50', '09:50'),
  ('CASTIGLIONE VILLAGE',  'FORIO',          '05:00', '09:50', '09:50'),
  -- BARANO (1 hotel)
  ('SAINT RAPHAEL',        'BARANO',         '05:00', '09:45', '09:45'),
  -- ISCHIA (18 hotel)
  ('BRISTOL',              'ISCHIA',         '05:15', '10:10', '10:10'),
  ('FELIX',                'ISCHIA',         '05:15', '10:10', '10:10'),
  ('PRESIDENT',            'ISCHIA',         '05:15', '10:10', '10:10'),
  ('RE FERDINANDO',        'ISCHIA',         '05:15', '10:10', '10:10'),
  ('TIRRENIA',             'ISCHIA',         '05:15', '10:10', '10:10'),
  ('CENTRAL PARK',         'ISCHIA',         '05:15', '10:10', '10:10'),
  ('SAN VALENTINO',        'ISCHIA',         '05:15', '10:10', '10:10'),
  ('BELLEVUE',             'ISCHIA',         '05:15', '10:10', '10:10'),
  ('DON PEPE',             'ISCHIA',         '05:15', '10:00', '10:00'),
  ('AUGUSTO',              'ISCHIA',         '05:15', '10:00', '10:00'),
  ('ISOLA VERDE',          'ISCHIA',         '05:15', '10:10', '10:10'),
  ('CONTINENTAL TERME',    'ISCHIA',         '05:15', '10:10', '10:10'),
  ('CONTINENTAL MARE',     'ISCHIA',         '05:15', '10:10', '10:10'),
  ('ARAGONA',              'ISCHIA',         '05:15', '10:10', '10:10'),
  ('PRINCIPE',             'ISCHIA',         '05:15', '10:10', '10:10'),
  ('ROYAL TERME',          'ISCHIA',         '05:15', '10:10', '10:10'),
  ('AURUM',                'ISCHIA',         '05:15', '10:10', '10:10'),
  ('HOTEL PINETA',         'ISCHIA',         '05:15', '10:10', '10:10'),
  -- LACCO AMENO (2 hotel)
  ('VILLA SVIZZERA',       'LACCO AMENO',    '05:15', '10:00', '10:00'),
  ('SAN LORENZO',          'LACCO AMENO',    '05:15', '10:00', '10:00'),
  -- CASAMICCIOLA T (3 hotel)
  ('CRISTALLO',            'CASAMICCIOLA T', '05:30', '10:00', '10:00'),
  ('GRAN PARADISO',        'CASAMICCIOLA T', '05:30', '10:00', '10:00'),
  ('STELLA MARIS',         'CASAMICCIOLA T', '05:30', '10:00', '10:00')
on conflict (upper(trim(hotel_name))) do update
  set comune                     = excluded.comune,
      pickup_time_linea_italia    = excluded.pickup_time_linea_italia,
      pickup_time_linea_centro    = excluded.pickup_time_linea_centro,
      pickup_time_linea_adriatica = excluded.pickup_time_linea_adriatica;

-- ──────────────────────────────────────────────────────────────────────────────
-- Aggiunta sicura di meeting_point su services (potrebbe mancare in alcune istanze)
-- ──────────────────────────────────────────────────────────────────────────────
alter table public.services
  add column if not exists meeting_point text null;

-- ──────────────────────────────────────────────────────────────────────────────
-- Aggiorna la view ops_bus_allocation_details:
--  1. Corregge driver_name → driver_name_outbound (dopo migration 0083)
--  2. Aggiunge hotel_pickup_time tramite LEFT JOIN su hotel_pickup_times
-- ──────────────────────────────────────────────────────────────────────────────
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
  -- Orario pick-up ritorno basato su hotel + linea bus
  -- Il nome hotel viene estratto da: hotels.name → meeting_point → notes ("Hotel: xxx")
  case lower(trim(l.family_code))
    when 'italia'    then hpt.pickup_time_linea_italia
    when 'centro'    then hpt.pickup_time_linea_centro
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
