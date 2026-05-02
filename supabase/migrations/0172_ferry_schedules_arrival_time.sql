-- Migration 0172: aggiunge arrival_time a ferry_schedules
-- Durate reali:
--   MEDMAR Pozzuoli ↔ Casamicciola / Ischia Porto : 65 min
--   MEDMAR Napoli   ↔ Ischia Porto                : 90 min
--   SNAV   Napoli   ↔ Casamicciola                : 65 min

alter table public.ferry_schedules
  add column if not exists arrival_time time null;

-- MEDMAR Pozzuoli ↔ Casamicciola/Ischia Porto (65 min)
update public.ferry_schedules
set arrival_time = (departure_time + interval '65 minutes')::time
where company = 'medmar'
  and (
    (departure_port = 'pozzuoli'    and arrival_port in ('casamicciola','ischia_porto'))
 or (departure_port in ('casamicciola','ischia_porto') and arrival_port = 'pozzuoli')
  );

-- MEDMAR Napoli ↔ Ischia Porto (90 min)
update public.ferry_schedules
set arrival_time = (departure_time + interval '90 minutes')::time
where company = 'medmar'
  and (
    (departure_port = 'napoli_beverello' and arrival_port = 'ischia_porto')
 or (departure_port = 'ischia_porto'    and arrival_port = 'napoli_beverello')
  );

-- SNAV Napoli Beverello ↔ Casamicciola (65 min)
update public.ferry_schedules
set arrival_time = (departure_time + interval '65 minutes')::time
where company = 'snav';
