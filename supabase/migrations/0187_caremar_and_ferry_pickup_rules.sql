-- Migration 0187: Caremar in ferry_schedules + tabella ferry_pickup_rules
-- Aggiunge Caremar (traghetto Pozzuoli↔Ischia Porto), aggiorna arrival_time Alilauro,
-- crea tabella ferry_pickup_rules con logica Aleste (tutte le agenzie eccetto Sosandra)
-- e logica Sosandra (treno traghetto, treno aliscafo, volo).

-- ─── 1. Aggiungi Caremar in ferry_schedules ────────────────────────────────────

insert into public.ferry_schedules
  (company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, notes)
values
  -- Pozzuoli → Ischia Porto (mainland_to_ischia)
  ('caremar', 'pozzuoli', 'ischia_porto', '09:25', '11:00', 'mainland_to_ischia', null, null),
  ('caremar', 'pozzuoli', 'ischia_porto', '10:45', '12:15', 'mainland_to_ischia', null, null),
  ('caremar', 'pozzuoli', 'ischia_porto', '15:10', '16:45', 'mainland_to_ischia', null, null),
  ('caremar', 'pozzuoli', 'ischia_porto', '17:35', '19:00', 'mainland_to_ischia', null, null),
  ('caremar', 'pozzuoli', 'ischia_porto', '19:00', '20:10', 'mainland_to_ischia', null, null),
  ('caremar', 'pozzuoli', 'ischia_porto', '21:55', '23:15', 'mainland_to_ischia', null, null);

-- ─── 2. Aggiorna arrival_time Alilauro (era NULL dopo mig 0172) ───────────────
-- Tempi di traversata reali dal PDF per la direzione mainland → Ischia Porto

update public.ferry_schedules
set arrival_time = case departure_time::text
  when '09:40' then '10:25'::time
  when '10:50' then '11:25'::time
  when '12:10' then '13:00'::time
  when '12:55' then '13:40'::time
  when '14:35' then '15:40'::time
  when '15:40' then '16:25'::time
  when '17:20' then '18:05'::time
  when '17:55' then '18:40'::time
  when '20:20' then '21:00'::time
  else null
end
where company = 'alilauro'
  and direction = 'mainland_to_ischia'
  and arrival_time is null;

-- ischia_to_mainland Alilauro: stima +45 minuti
update public.ferry_schedules
set arrival_time = (departure_time + interval '45 minutes')::time
where company = 'alilauro'
  and direction = 'ischia_to_mainland'
  and arrival_time is null;

-- ─── 3. Crea tabella ferry_pickup_rules ───────────────────────────────────────

create table if not exists public.ferry_pickup_rules (
  id              uuid        primary key default gen_random_uuid(),
  agency_logic    text        not null check (agency_logic in ('aleste', 'sosandra')),
  transport_type  text        not null check (transport_type in ('train', 'flight')),
  -- boat_type distingue, per Sosandra TRENO, se usare traghetto o aliscafo
  boat_type       text        not null default 'traghetto' check (boat_type in ('traghetto', 'aliscafo')),
  -- finestra orario arrivo del mezzo (treno/volo arriva tra transport_from e transport_to)
  transport_from  time        not null,
  transport_to    time        not null,
  -- corsa nave da prendere
  company         text        not null,
  departure_time  time        not null,   -- lettura sola nell'UI (non modificabile dall'operatore)
  arrival_port    text        not null,   -- 'ischia_porto' | 'casamicciola'
  arrival_time    time,                   -- orario sbarco previsto
  -- validità stagionale (null = sempre valido)
  valid_from      date,
  valid_to        date,
  -- null = tutti i giorni, altrimenti array ISO: 0=dom, 1=lun, …, 6=sab
  days_of_week    integer[],
  season_notes    text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Indice per lookup: agency_logic + transport_type + boat_type + finestra orario
create index if not exists ferry_pickup_rules_lookup_idx
  on public.ferry_pickup_rules (agency_logic, transport_type, boat_type, transport_from, transport_to);

-- RLS
alter table public.ferry_pickup_rules enable row level security;

create policy "ferry_pickup_rules_read" on public.ferry_pickup_rules
  for select using (auth.role() = 'authenticated');

create policy "ferry_pickup_rules_write" on public.ferry_pickup_rules
  for all using (auth.role() = 'service_role');

-- ─── 4. SEED: Logica ALESTE — VOLO (8 record) ────────────────────────────────
-- Tutte le agenzie eccetto Sosandra usano questa logica per i voli.

insert into public.ferry_pickup_rules
  (agency_logic, transport_type, boat_type, transport_from, transport_to,
   company, departure_time, arrival_port, arrival_time,
   valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'flight', 'traghetto', '07:00', '08:00', 'medmar',  '08:40', 'ischia_porto', '10:00', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '08:05', '08:30', 'caremar', '09:25', 'ischia_porto', '11:00', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '08:35', '10:00', 'caremar', '10:45', 'ischia_porto', '12:15', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '10:05', '13:30', 'medmar',  '14:20', 'ischia_porto', '15:40', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '13:35', '14:30', 'caremar', '15:10', 'ischia_porto', '16:45', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '14:35', '16:30', 'caremar', '17:35', 'ischia_porto', '19:00', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '16:35', '18:30', 'medmar',  '19:00', 'ischia_porto', '20:15', null,         null,         null,    null),
  ('aleste', 'flight', 'traghetto', '18:35', '20:30', 'caremar', '21:55', 'ischia_porto', '23:15', null,         null,         null,    null);

-- ─── 5. SEED: Logica ALESTE — TRENO (13 record) ──────────────────────────────

insert into public.ferry_pickup_rules
  (agency_logic, transport_type, boat_type, transport_from, transport_to,
   company, departure_time, arrival_port, arrival_time,
   valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'train', 'traghetto', '07:00', '09:00', 'medmar',  '12:00', 'casamicciola', '13:00', null,         null,         null, null),
  ('aleste', 'train', 'traghetto', '09:05', '10:50', 'medmar',  '12:00', 'casamicciola', '13:00', null,         null,         null, null),
  ('aleste', 'train', 'traghetto', '10:55', '12:13', 'medmar',  '13:30', 'ischia_porto', '14:30', null,         null,         null, null),
  -- fascia 12:15–13:30: stagione estiva → Ischia Porto, invernale → Casamicciola
  ('aleste', 'train', 'traghetto', '12:15', '13:30', 'medmar',  '14:20', 'ischia_porto', '15:40', '2026-05-01', '2026-09-15', null, 'estate'),
  ('aleste', 'train', 'traghetto', '12:15', '13:30', 'medmar',  '15:00', 'casamicciola', '16:00', '2026-09-16', '2027-04-30', null, 'inverno'),
  -- fascia 13:35–13:55: stessa stagionalità
  ('aleste', 'train', 'traghetto', '13:35', '13:55', 'medmar',  '14:20', 'ischia_porto', '15:40', '2026-05-01', '2026-09-15', null, 'estate'),
  ('aleste', 'train', 'traghetto', '13:35', '13:55', 'medmar',  '15:00', 'casamicciola', '16:00', '2026-09-16', '2027-04-30', null, 'inverno'),
  ('aleste', 'train', 'traghetto', '14:00', '14:15', 'medmar',  '15:00', 'casamicciola', '16:00', null,         null,         null, null),
  ('aleste', 'train', 'traghetto', '14:20', '15:45', 'medmar',  '16:30', 'ischia_porto', '17:30', null,         null,         null, null),
  ('aleste', 'train', 'traghetto', '15:50', '17:15', 'medmar',  '18:30', 'casamicciola', '19:30', null,         null,         null, null),
  -- fascia 17:20–18:15: MEDMAR estate, CAREMAR inverno
  ('aleste', 'train', 'traghetto', '17:20', '18:15', 'medmar',  '19:00', 'ischia_porto', '20:15', '2026-05-01', '2026-09-15', null, 'estate'),
  ('aleste', 'train', 'traghetto', '17:20', '18:15', 'caremar', '19:00', 'ischia_porto', '20:10', '2026-09-16', '2027-04-30', null, 'inverno'),
  ('aleste', 'train', 'traghetto', '18:20', '21:20', 'caremar', '21:55', 'ischia_porto', '23:15', null,         null,         null, null);

-- ─── 6. SEED: Logica SOSANDRA — TRENO TRAGHETTO (12 record) ──────────────────
-- Sosandra offre al cliente la scelta tra traghetto e aliscafo per i treni.
-- Questa sezione gestisce la scelta traghetto (MEDMAR/CAREMAR).

insert into public.ferry_pickup_rules
  (agency_logic, transport_type, boat_type, transport_from, transport_to,
   company, departure_time, arrival_port, arrival_time,
   valid_from, valid_to, days_of_week, season_notes)
values
  ('sosandra', 'train', 'traghetto', '07:00', '09:00', 'medmar',  '12:00', 'casamicciola', '13:00', null,         null,         null, null),
  ('sosandra', 'train', 'traghetto', '09:05', '10:50', 'medmar',  '12:00', 'casamicciola', '13:00', null,         null,         null, null),
  ('sosandra', 'train', 'traghetto', '10:55', '12:13', 'medmar',  '13:30', 'ischia_porto', '14:30', null,         null,         null, null),
  ('sosandra', 'train', 'traghetto', '12:15', '13:30', 'medmar',  '14:20', 'ischia_porto', '15:40', '2026-05-01', '2026-09-15', null, 'estate'),
  ('sosandra', 'train', 'traghetto', '12:15', '13:30', 'medmar',  '15:00', 'casamicciola', '16:00', '2026-09-16', '2027-04-30', null, 'inverno'),
  ('sosandra', 'train', 'traghetto', '13:35', '13:55', 'medmar',  '14:20', 'ischia_porto', '15:40', '2026-05-01', '2026-09-15', null, 'estate'),
  ('sosandra', 'train', 'traghetto', '13:35', '13:55', 'medmar',  '15:00', 'casamicciola', '16:00', '2026-09-16', '2027-04-30', null, 'inverno'),
  ('sosandra', 'train', 'traghetto', '14:00', '14:15', 'medmar',  '15:00', 'casamicciola', '16:00', null,         null,         null, null),
  ('sosandra', 'train', 'traghetto', '14:20', '15:45', 'medmar',  '16:30', 'ischia_porto', '17:30', null,         null,         null, null),
  ('sosandra', 'train', 'traghetto', '15:50', '17:15', 'medmar',  '18:30', 'casamicciola', '19:30', null,         null,         null, null),
  ('sosandra', 'train', 'traghetto', '17:20', '18:15', 'medmar',  '19:00', 'ischia_porto', '20:15', '2026-05-01', '2026-09-15', null, 'estate'),
  ('sosandra', 'train', 'traghetto', '18:20', '21:20', 'caremar', '21:55', 'ischia_porto', '23:15', null,         null,         null, null);

-- ─── 7. SEED: Logica SOSANDRA — TRENO ALISCAFO (13 record) ───────────────────
-- Scelta aliscafo per i treni: SNAV/Alilauro (veloci, Casamicciola o Ischia Porto).

insert into public.ferry_pickup_rules
  (agency_logic, transport_type, boat_type, transport_from, transport_to,
   company, departure_time, arrival_port, arrival_time,
   valid_from, valid_to, days_of_week, season_notes)
values
  ('sosandra', 'train', 'aliscafo', '07:00', '08:00', 'snav',     '08:30', 'casamicciola', '09:30', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '08:05', '09:00', 'alilauro', '09:40', 'ischia_porto', '10:25', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '09:05', '10:00', 'alilauro', '10:50', 'ischia_porto', '11:25', null,         null,         null,   null),
  -- 10:05-10:45: SNAV solo ven+dom maggio, poi ALILAURO da settembre
  ('sosandra', 'train', 'aliscafo', '10:05', '10:45', 'snav',     '11:30', 'casamicciola', '12:30', '2026-05-02', '2026-05-30', '{0,5}', 'ven+dom mag'),
  ('sosandra', 'train', 'aliscafo', '10:05', '10:45', 'alilauro', '10:50', 'ischia_porto', '11:40', '2026-09-01', '2027-04-30', null,   'da set'),
  ('sosandra', 'train', 'aliscafo', '11:00', '11:40', 'alilauro', '12:10', 'ischia_porto', '13:00', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '11:45', '12:30', 'alilauro', '12:55', 'ischia_porto', '13:40', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '12:35', '14:00', 'alilauro', '14:35', 'ischia_porto', '15:40', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '14:05', '15:00', 'alilauro', '15:40', 'ischia_porto', '16:25', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '15:05', '15:50', 'snav',     '16:20', 'casamicciola', '17:20', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '16:00', '16:40', 'alilauro', '17:20', 'ischia_porto', '18:05', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '16:45', '17:15', 'alilauro', '17:55', 'ischia_porto', '18:40', null,         null,         null,   null),
  ('sosandra', 'train', 'aliscafo', '17:30', '19:50', 'alilauro', '20:20', 'ischia_porto', '21:00', null,         null,         null,   null);

-- ─── 8. SEED: Logica SOSANDRA — VOLO (14 record) ─────────────────────────────
-- Sosandra abbina sempre aliscafo per i voli.

insert into public.ferry_pickup_rules
  (agency_logic, transport_type, boat_type, transport_from, transport_to,
   company, departure_time, arrival_port, arrival_time,
   valid_from, valid_to, days_of_week, season_notes)
values
  ('sosandra', 'flight', 'aliscafo', '07:00', '07:45', 'snav',     '08:30', 'casamicciola', '09:30', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '08:00', '09:00', 'alilauro', '09:40', 'ischia_porto', '10:25', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '09:05', '10:00', 'alilauro', '10:50', 'ischia_porto', '11:25', null,         null,         null,   null),
  -- 10:05-10:45: SNAV ven+dom mag, SNAV tutto giugno-set, ALILAURO da settembre
  ('sosandra', 'flight', 'aliscafo', '10:05', '10:45', 'snav',     '11:30', 'casamicciola', '12:30', '2026-05-02', '2026-05-30', '{0,5}', 'ven+dom mag'),
  ('sosandra', 'flight', 'aliscafo', '10:05', '10:45', 'snav',     '11:30', 'casamicciola', '12:30', '2026-06-01', '2026-09-30', null,   'giu-set'),
  ('sosandra', 'flight', 'aliscafo', '10:05', '10:45', 'alilauro', '10:50', 'ischia_porto', '11:40', '2026-09-01', '2027-04-30', null,   'da set'),
  ('sosandra', 'flight', 'aliscafo', '11:00', '11:40', 'alilauro', '12:10', 'ischia_porto', '13:00', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '11:45', '12:30', 'alilauro', '12:55', 'ischia_porto', '13:40', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '12:35', '14:00', 'alilauro', '14:35', 'ischia_porto', '15:40', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '14:05', '15:00', 'alilauro', '15:40', 'ischia_porto', '16:25', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '15:05', '15:50', 'snav',     '16:20', 'casamicciola', '17:20', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '16:00', '16:40', 'alilauro', '17:20', 'ischia_porto', '18:05', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '16:45', '17:15', 'alilauro', '17:55', 'ischia_porto', '18:40', null,         null,         null,   null),
  ('sosandra', 'flight', 'aliscafo', '17:30', '19:50', 'alilauro', '20:20', 'ischia_porto', '21:00', null,         null,         null,   null);
