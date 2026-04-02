-- Migration 0088: Programma escursioni reale dal 1° Aprile 2026
-- Aggiunge: giorni della settimana, prezzi, orario ritorno, orari pickup per luogo

-- ── Nuove colonne su excursion_lines ─────────────────────────────────────────
alter table public.excursion_lines
  add column if not exists days_of_week  integer[] not null default '{}',
  -- 0=Dom, 1=Lun, 2=Mar, 3=Mer, 4=Gio, 5=Ven, 6=Sab
  add column if not exists price_agency_cents  integer not null default 0,
  add column if not exists price_retail_cents  integer not null default 0,
  add column if not exists return_time  time null,
  add column if not exists valid_from   date null,
  add column if not exists min_pax      integer not null default 20,
  add column if not exists excursion_type text not null default 'mare'
    check (excursion_type in ('mare','terra','misto'));

-- ── Orari pickup per escursione per luogo ────────────────────────────────────
create table if not exists public.excursion_pickups (
  id                  uuid    primary key default gen_random_uuid(),
  excursion_line_id   uuid    not null references public.excursion_lines (id) on delete cascade,
  location            text    not null,   -- es. 'Forio', 'Lacco Ameno', 'Casamicciola', 'Ischia Porto'
  pickup_time         time    not null,
  sort_order          integer not null default 0
);

create index if not exists idx_excursion_pickups_line
  on public.excursion_pickups (excursion_line_id);

alter table public.excursion_pickups enable row level security;

drop policy if exists excursion_pickups_select on public.excursion_pickups;
create policy excursion_pickups_select on public.excursion_pickups
for select using (
  exists (
    select 1 from public.excursion_lines l
    where l.id = excursion_pickups.excursion_line_id
    and l.tenant_id = public.current_tenant_id()
  )
);

drop policy if exists excursion_pickups_admin_all on public.excursion_pickups;
create policy excursion_pickups_admin_all on public.excursion_pickups
for all
using (
  exists (
    select 1 from public.excursion_lines l
    where l.id = excursion_pickups.excursion_line_id
    and l.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin','operator')
  )
)
with check (
  exists (
    select 1 from public.excursion_lines l
    where l.id = excursion_pickups.excursion_line_id
    and l.tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin','operator')
  )
);

-- ── Rimuovi seed generico (0087) e inserisci programma reale ─────────────────
delete from public.excursion_lines
where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a';

-- ── SEED: Programma Escursioni dal 1° Aprile 2026 ────────────────────────────
-- Nota giorni: 0=Dom 1=Lun 2=Mar 3=Mer 4=Gio 5=Ven 6=Sab

-- CAPRI orario A: Lun / Mer / Ven / Dom
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, return_time, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Capri — orario A',
   'Lunedì · Mercoledì · Venerdì · Domenica · 6h sosta',
   '#0ea5e9', '⛵', 1, 'mare',
   array[1,3,5,0], 5000, 5500, '16:40', 1);

-- CAPRI orario B: Mar / Gio / Sab / Dom
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, return_time, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Capri — orario B',
   'Martedì · Giovedì · Sabato · Domenica · 6h sosta',
   '#0284c7', '⛵', 2, 'mare',
   array[2,4,6,0], 5000, 5500, '16:45', 1);

-- SORRENTO: Mercoledì
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, return_time, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Sorrento',
   'Mercoledì · 4h sosta',
   '#d97706', '🌊', 3, 'mare',
   array[3], 5500, 6000, '15:20', 1);

-- POSITANO & AMALFI: Giovedì / Domenica (dal 21/04 anche Martedì)
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, return_time, min_pax, valid_from)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Positano & Amalfi',
   'Giovedì · Domenica (Martedì dal 21/04)',
   '#dc2626', '🏖️', 4, 'mare',
   array[4,0], 5500, 6000, '15:45', 1, '2026-04-01');

-- GIRO ISOLA MOTONAVE (pomeriggio): Lun/Mer → orario A, Gio/Ven/Sab → orario B
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, return_time, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Giro Isola Motonave — A',
   'Lunedì · Mercoledì · 1h sosta Sant''Angelo. Ritorno 17:10',
   '#16a34a', '🏝️', 5, 'mare',
   array[1,3], 1500, 2500, '17:10', 1),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Giro Isola Motonave — B',
   'Giovedì · Venerdì · Sabato · 1h sosta Sant''Angelo. Ritorno 17:00',
   '#15803d', '🏝️', 6, 'mare',
   array[4,5,6], 1500, 2500, '17:00', 1);

-- GIRO ISOLA MINIBUS: Mercoledì / Venerdì
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Giro Isola Minibus',
   'Mercoledì · Venerdì · in minibus',
   '#059669', '🚐', 7, 'terra',
   array[3,5], 1000, 1500, 1);

-- PROCIDA MOTONAVE: Mar/Gio (18:00), Mer/Ven (18:30, dal 08/04)
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, return_time, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Procida Motonave — A',
   'Martedì · Giovedì · 2h sosta. Ritorno 18:00',
   '#7c3aed', '🚢', 8, 'mare',
   array[2,4], 1500, 2500, '18:00', 1),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Procida Motonave — B',
   'Mercoledì · Venerdì · 2h sosta. Ritorno 18:30 (dal 08/04)',
   '#6d28d9', '🚢', 9, 'mare',
   array[3,5], 1500, 2500, '18:30', 1);

-- CASTELLO ARAGONESE: Martedì / Venerdì (mattina)
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Castello Aragonese',
   'Martedì · Venerdì · mattina',
   '#b45309', '🏰', 10, 'terra',
   array[2,5], 3000, 3500, 1);

-- LA MORTELLA: Giovedì
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'La Mortella',
   'Giovedì',
   '#65a30d', '🌿', 11, 'terra',
   array[4], 2500, 3000, 1);

-- NITRODI: Giovedì / Sabato
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Nitrodi',
   'Giovedì · Sabato',
   '#0891b2', '♨️', 12, 'terra',
   array[4,6], 2200, 2800, 1);

-- COOKING CLASS: Giovedì
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Cooking Class',
   'Giovedì · Dolci tipici campani',
   '#f59e0b', '🍰', 13, 'terra',
   array[4], 5300, 6000, 1);

-- ESCURSIONE CRATERI: Sabato
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Escursione Crateri',
   'Sabato',
   '#dc2626', '🌋', 14, 'terra',
   array[6], 2000, 2500, 1);

-- PASSEGGIATA A NAPOLI: Domenica
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Passeggiata a Napoli',
   'Domenica',
   '#64748b', '🏙️', 15, 'terra',
   array[0], 4500, 5500, 1);

-- POMPEI: Domenica
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Pompei',
   'Domenica · Ingresso scavi €20 + auricolari €3',
   '#92400e', '🏛️', 16, 'terra',
   array[0], 5000, 6000, 1);

-- CASERTA: Domenica
insert into public.excursion_lines
  (tenant_id, name, description, color, icon, sort_order, excursion_type,
   days_of_week, price_agency_cents, price_retail_cents, min_pax)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a',
   'Caserta',
   'Domenica · Ingresso Reggia €20 + auricolari €3',
   '#78350f', '👑', 17, 'terra',
   array[0], 5000, 6000, 1);

-- ── Orari pickup per le escursioni MARE ──────────────────────────────────────
-- Capri orario A (Lun/Mer/Ven/Dom)
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Capri — orario A')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '08:00', 1),
    ('Lacco Ameno',  '08:10', 2),
    ('Casamicciola', '08:20', 3),
    ('Ischia Porto', '08:50', 4)
  ) as loc(location, pickup_time, sort_order);

-- Capri orario B (Mar/Gio/Sab/Dom)
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Capri — orario B')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '08:40', 1),
    ('Lacco Ameno',  '08:50', 2),
    ('Casamicciola', '09:00', 3),
    ('Ischia Porto', '09:20', 4)
  ) as loc(location, pickup_time, sort_order);

-- Sorrento (Mer)
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Sorrento')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '08:00', 1),
    ('Lacco Ameno',  '08:10', 2),
    ('Casamicciola', '08:20', 3),
    ('Ischia Porto', '08:50', 4)
  ) as loc(location, pickup_time, sort_order);

-- Positano & Amalfi (Gio/Dom)
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Positano & Amalfi')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '08:40', 1),
    ('Lacco Ameno',  '08:50', 2),
    ('Casamicciola', '09:00', 3),
    ('Ischia Porto', '09:20', 4)
  ) as loc(location, pickup_time, sort_order);

-- Giro Isola Motonave A (Lun/Mer) — pomeriggio
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Giro Isola Motonave — A')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '14:35', 1),
    ('Lacco Ameno',  '14:45', 2),
    ('Casamicciola', '15:05', 3),
    ('Ischia Porto', '15:20', 4)
  ) as loc(location, pickup_time, sort_order);

-- Giro Isola Motonave B (Gio/Ven/Sab) — pomeriggio
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Giro Isola Motonave — B')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Ischia Porto', '14:45', 1),
    ('Casamicciola', '14:55', 2),
    ('Lacco Ameno',  '15:05', 3),
    ('Forio',        '15:25', 4)
  ) as loc(location, pickup_time, sort_order);

-- Procida Motonave A (Mar/Gio)
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Procida Motonave — A')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '14:30', 1),
    ('Lacco Ameno',  '14:50', 2),
    ('Casamicciola', '15:00', 3),
    ('Ischia Porto', '15:15', 4)
  ) as loc(location, pickup_time, sort_order);

-- Procida Motonave B (Mer/Ven)
with line as (select id from public.excursion_lines where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a' and name = 'Procida Motonave — B')
insert into public.excursion_pickups (excursion_line_id, location, pickup_time, sort_order)
select l.id, loc.location, loc.pickup_time::time, loc.sort_order
from line l,
  (values
    ('Forio',        '14:30', 1),
    ('Lacco Ameno',  '14:45', 2),
    ('Casamicciola', '14:55', 3),
    ('Ischia Porto', '15:20', 4)
  ) as loc(location, pickup_time, sort_order);
