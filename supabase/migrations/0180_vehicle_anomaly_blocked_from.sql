-- Aggiunge data inizio blocco per le anomalie veicolo
alter table public.vehicle_anomalies
  add column if not exists blocked_from timestamptz;
