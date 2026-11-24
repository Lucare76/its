-- Nome dell'autista che ha effettuato il rifornimento.
-- Da QR viene dichiarato dall'autista (precompilato con chi ha il turno aperto
-- sul mezzo); da ufficio è inserito o corretto manualmente.
-- Testo libero come vehicle_km_logs.driver_name: il QR è pubblico e non
-- identifica l'autista con un account, quindi un FK sarebbe una falsa garanzia.
alter table public.vehicle_fuel
  add column if not exists driver_name text null
    check (driver_name is null or char_length(btrim(driver_name)) between 1 and 120);
