-- Aggiunge colonna notes a status_events per tracciare dettagli
-- (tratta cancellata, penale applicata, ecc.)
alter table public.status_events
  add column if not exists notes text null;
