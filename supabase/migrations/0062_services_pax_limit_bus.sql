-- Aumenta il limite pax da 16 a 500 per supportare i gruppi su linea bus.
-- Il limite originale di 16 era pensato per i transfer individuali su auto/van.
-- I servizi bus possono avere gruppi interi (es. 50+ pax per pullman).
alter table public.services
  drop constraint if exists services_pax_check,
  add constraint services_pax_check check (pax > 0 and pax <= 500);
