-- Migration 0067: aggiunge radius_vehicle_id alla tabella vehicles
-- Permette il mapping tra un mezzo del PMS e un veicolo GPS Radius/Kinesis

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS radius_vehicle_id TEXT DEFAULT NULL;

COMMENT ON COLUMN vehicles.radius_vehicle_id IS
  'ID veicolo nel sistema GPS Radius/Kinesis. Usato per il tracking live sulla Mappa Live.';
