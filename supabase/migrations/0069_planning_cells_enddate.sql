-- Aggiunge end_date per i blocchi multi-giorno del Planning Bus Generali (stile alberghiero)
ALTER TABLE tenant_planning_cells
  ADD COLUMN IF NOT EXISTS end_date date;
