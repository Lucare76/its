-- Migration 0207: mezzo fisso per autista per fascia oraria giornaliera
--
-- Permette di dichiarare fino a 2 mezzi per autista nella disponibilità del giorno,
-- ciascuno con fascia oraria di validità. Il planner usa questo binding per
-- assegnare sempre il mezzo corretto senza mai cambiarlo durante la giornata.

alter table public.driver_daily_availability
  add column if not exists vehicle_1_id   uuid references public.vehicles(id) on delete set null,
  add column if not exists vehicle_1_from time,
  add column if not exists vehicle_1_to   time,
  add column if not exists vehicle_2_id   uuid references public.vehicles(id) on delete set null,
  add column if not exists vehicle_2_from time,
  add column if not exists vehicle_2_to   time;
