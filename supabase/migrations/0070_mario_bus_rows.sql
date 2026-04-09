-- Mezzi del Mario Planning — indipendenti da tenant_bus_units (Rete Bus)
CREATE TABLE IF NOT EXISTS tenant_mario_bus_rows (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  uuid        NOT NULL,
  label      text        NOT NULL,
  sort_order integer     NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mario_bus_rows_tenant
  ON tenant_mario_bus_rows (tenant_id, sort_order);

ALTER TABLE tenant_mario_bus_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_members_mario_bus_rows" ON tenant_mario_bus_rows;
CREATE POLICY "tenant_members_mario_bus_rows"
  ON tenant_mario_bus_rows
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM memberships WHERE user_id = auth.uid()
    )
  );
