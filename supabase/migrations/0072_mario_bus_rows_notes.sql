-- Aggiunge campo notes (es. "POSTI 51+1") ai mezzi del Mario Planning
ALTER TABLE tenant_mario_bus_rows
  ADD COLUMN IF NOT EXISTS notes text;
