-- Planning cells per Mario Planning (Planning Bus + Planning Tratta)
CREATE TABLE IF NOT EXISTS tenant_planning_cells (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  planning_type  text        NOT NULL,  -- 'bus' | 'route'
  cell_date      date        NOT NULL,
  row_key        text        NOT NULL,  -- bus: bus_unit_id; route: cell_date string
  col_index      integer     NOT NULL DEFAULT 0,
  content        text,
  bg_color       text,                  -- 'yellow' | 'red' | 'green' | 'blue' | 'orange'
  service_id     uuid,                  -- opzionale: link a una prenotazione
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  CONSTRAINT uq_planning_cell UNIQUE (tenant_id, planning_type, cell_date, row_key, col_index)
);

CREATE INDEX IF NOT EXISTS idx_planning_cells_tenant_type_date
  ON tenant_planning_cells (tenant_id, planning_type, cell_date);

ALTER TABLE tenant_planning_cells ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_members_planning_cells"
  ON tenant_planning_cells
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM memberships WHERE user_id = auth.uid()
    )
  );
