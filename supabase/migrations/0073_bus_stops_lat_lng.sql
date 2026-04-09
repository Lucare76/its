-- Aggiunge coordinate geografiche alle fermate bus per il geo-sort
ALTER TABLE tenant_bus_line_stops
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision;
