-- ─── Corse traghetti/aliscafi ────────────────────────────────────────────────
-- Tabella con tutti gli orari Medmar, SNAV, Alilauro
-- Usata per calcolare automaticamente la corsa giusta in base all'orario treno/volo

create table if not exists ferry_schedules (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,        -- 'medmar' | 'snav' | 'alilauro'
  departure_port text not null,       -- 'ischia_porto' | 'casamicciola' | 'napoli_beverello' | 'pozzuoli'
  arrival_port  text not null,        -- stessa enum
  departure_time time not null,       -- orario partenza
  direction     text not null,        -- 'ischia_to_mainland' | 'mainland_to_ischia'
  days_of_week  integer[] default null, -- null = tutti i giorni, altrimenti [0..6] ISO (0=Dom..6=Sab)
  valid_from    date default null,    -- null = sempre valido
  valid_to      date default null,    -- null = sempre valido
  notes         text default null,
  created_at    timestamptz default now()
);

-- Indice per lookup rapida
create index if not exists ferry_schedules_direction_idx on ferry_schedules (direction, company, departure_time);

-- RLS: lettura libera per utenti autenticati
alter table ferry_schedules enable row level security;

create policy "ferry_schedules_read" on ferry_schedules
  for select using (auth.role() = 'authenticated');

create policy "ferry_schedules_admin_write" on ferry_schedules
  for all using (auth.role() = 'service_role');

-- ─── SEED: Medmar ────────────────────────────────────────────────────────────
-- Partenze da Ischia verso terraferma

insert into ferry_schedules (company, departure_port, arrival_port, departure_time, direction, days_of_week, notes) values
-- Ischia Porto → Napoli
('medmar', 'ischia_porto', 'napoli_beverello', '06:25', 'ischia_to_mainland', '{1,2,3,4,5}', 'feriale'),
('medmar', 'ischia_porto', 'napoli_beverello', '10:35', 'ischia_to_mainland', null, null),
('medmar', 'ischia_porto', 'napoli_beverello', '17:00', 'ischia_to_mainland', null, null),
-- Ischia Porto → Pozzuoli
('medmar', 'ischia_porto', 'pozzuoli', '04:30', 'ischia_to_mainland', '{1,2,3,4,5}', 'feriale'),
('medmar', 'ischia_porto', 'pozzuoli', '08:10', 'ischia_to_mainland', null, null),
('medmar', 'ischia_porto', 'pozzuoli', '11:10', 'ischia_to_mainland', null, null),
('medmar', 'ischia_porto', 'pozzuoli', '15:00', 'ischia_to_mainland', null, null),
-- Casamicciola → Pozzuoli
('medmar', 'casamicciola', 'pozzuoli', '02:30', 'ischia_to_mainland', '{1,2,3,4,5}', 'feriale'),
('medmar', 'casamicciola', 'pozzuoli', '06:20', 'ischia_to_mainland', null, null),
('medmar', 'casamicciola', 'pozzuoli', '10:10', 'ischia_to_mainland', null, null),
('medmar', 'casamicciola', 'pozzuoli', '13:35', 'ischia_to_mainland', null, null),
('medmar', 'casamicciola', 'pozzuoli', '16:50', 'ischia_to_mainland', null, null);

-- Arrivi a Ischia da terraferma
insert into ferry_schedules (company, departure_port, arrival_port, departure_time, direction, days_of_week, notes) values
-- Napoli → Ischia Porto
('medmar', 'napoli_beverello', 'ischia_porto', '08:40', 'mainland_to_ischia', null, null),
('medmar', 'napoli_beverello', 'ischia_porto', '14:20', 'mainland_to_ischia', null, null),
('medmar', 'napoli_beverello', 'ischia_porto', '19:00', 'mainland_to_ischia', null, null),
-- Pozzuoli → Ischia Porto
('medmar', 'pozzuoli', 'ischia_porto', '06:25', 'mainland_to_ischia', '{1,2,3,4,5}', 'feriale'),
('medmar', 'pozzuoli', 'ischia_porto', '09:40', 'mainland_to_ischia', null, null),
('medmar', 'pozzuoli', 'ischia_porto', '13:30', 'mainland_to_ischia', null, null),
('medmar', 'pozzuoli', 'ischia_porto', '16:30', 'mainland_to_ischia', null, null),
-- Pozzuoli → Casamicciola
('medmar', 'pozzuoli', 'casamicciola', '04:10', 'mainland_to_ischia', '{1,2,3,4,5}', 'feriale'),
('medmar', 'pozzuoli', 'casamicciola', '08:15', 'mainland_to_ischia', null, null),
('medmar', 'pozzuoli', 'casamicciola', '12:00', 'mainland_to_ischia', null, null),
('medmar', 'pozzuoli', 'casamicciola', '15:00', 'mainland_to_ischia', null, null),
('medmar', 'pozzuoli', 'casamicciola', '18:30', 'mainland_to_ischia', null, null);

-- ─── SEED: SNAV ──────────────────────────────────────────────────────────────
-- Casamicciola → Napoli Beverello (via Procida)
insert into ferry_schedules (company, departure_port, arrival_port, departure_time, direction, days_of_week, valid_from, valid_to, notes) values
('snav', 'casamicciola', 'napoli_beverello', '07:10', 'ischia_to_mainland', null, null, null, 'tutto l''anno'),
('snav', 'casamicciola', 'napoli_beverello', '09:45', 'ischia_to_mainland', null, null, null, 'tutto l''anno'),
('snav', 'casamicciola', 'napoli_beverello', '10:30', 'ischia_to_mainland', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'casamicciola', 'napoli_beverello', '12:50', 'ischia_to_mainland', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'casamicciola', 'napoli_beverello', '13:15', 'ischia_to_mainland', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'casamicciola', 'napoli_beverello', '14:00', 'ischia_to_mainland', null, null, null, 'tutto l''anno'),
('snav', 'casamicciola', 'napoli_beverello', '15:15', 'ischia_to_mainland', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'casamicciola', 'napoli_beverello', '17:40', 'ischia_to_mainland', null, null, null, 'tutto l''anno'),
('snav', 'casamicciola', 'napoli_beverello', '18:30', 'ischia_to_mainland', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom');

-- Napoli Beverello → Casamicciola (via Procida)
insert into ferry_schedules (company, departure_port, arrival_port, departure_time, direction, days_of_week, valid_from, valid_to, notes) values
('snav', 'napoli_beverello', 'casamicciola', '08:10', 'mainland_to_ischia', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'napoli_beverello', 'casamicciola', '08:30', 'mainland_to_ischia', null, null, null, 'tutto l''anno'),
('snav', 'napoli_beverello', 'casamicciola', '09:20', 'mainland_to_ischia', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'napoli_beverello', 'casamicciola', '11:30', 'mainland_to_ischia', '{5,6,0,1}', '2026-06-06', '2026-09-13', 'ven/sab/dom/lun'),
('snav', 'napoli_beverello', 'casamicciola', '12:30', 'mainland_to_ischia', null, null, null, 'tutto l''anno'),
('snav', 'napoli_beverello', 'casamicciola', '13:55', 'mainland_to_ischia', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'napoli_beverello', 'casamicciola', '15:10', 'mainland_to_ischia', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'napoli_beverello', 'casamicciola', '16:20', 'mainland_to_ischia', null, null, null, 'tutto l''anno'),
('snav', 'napoli_beverello', 'casamicciola', '17:10', 'mainland_to_ischia', '{5,6,0}', '2026-06-01', '2026-09-28', 'ven/sab/dom'),
('snav', 'napoli_beverello', 'casamicciola', '19:00', 'mainland_to_ischia', null, null, null, 'tutto l''anno');

-- ─── SEED: Alilauro ──────────────────────────────────────────────────────────
-- Ischia Porto → Napoli Beverello
insert into ferry_schedules (company, departure_port, arrival_port, departure_time, direction, days_of_week, notes) values
('alilauro', 'ischia_porto', 'napoli_beverello', '06:30', 'ischia_to_mainland', '{1,2,3,4,5}', 'feriale'),
('alilauro', 'ischia_porto', 'napoli_beverello', '07:10', 'ischia_to_mainland', '{1,2,3,4,5}', 'feriale'),
('alilauro', 'ischia_porto', 'napoli_beverello', '08:05', 'ischia_to_mainland', '{1,2,3,4}',   'escluso sab/festivi'),
('alilauro', 'ischia_porto', 'napoli_beverello', '08:40', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '09:35', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '11:45', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '13:20', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '14:05', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '16:15', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '16:55', 'ischia_to_mainland', null,           'tutto l''anno'),
('alilauro', 'ischia_porto', 'napoli_beverello', '18:05', 'ischia_to_mainland', '{0}',          'festivo'),
('alilauro', 'ischia_porto', 'napoli_beverello', '19:10', 'ischia_to_mainland', null,           'tutto l''anno');

-- Napoli Beverello → Ischia Porto
insert into ferry_schedules (company, departure_port, arrival_port, departure_time, direction, days_of_week, notes) values
('alilauro', 'napoli_beverello', 'ischia_porto', '06:50', 'mainland_to_ischia', '{1,2,3,4}',   'escluso sab/festivi'),
('alilauro', 'napoli_beverello', 'ischia_porto', '07:35', 'mainland_to_ischia', '{1,2,3,4,5}', 'feriale'),
('alilauro', 'napoli_beverello', 'ischia_porto', '09:40', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '10:50', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '12:10', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '12:55', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '14:35', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '15:40', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '17:20', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '17:55', 'mainland_to_ischia', null,           'tutto l''anno'),
('alilauro', 'napoli_beverello', 'ischia_porto', '20:20', 'mainland_to_ischia', null,           'tutto l''anno');
