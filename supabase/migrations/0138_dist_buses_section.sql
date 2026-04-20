-- Aggiunge colonna section a bus_ischia_dist_buses per distinguere
-- smistamento Ischia (arrivi dal continente) da smistamento Pozzuoli (ritorni dall'isola).
ALTER TABLE public.bus_ischia_dist_buses
  ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'ischia'
  CHECK (section IN ('ischia', 'pozzuoli'));

CREATE INDEX IF NOT EXISTS bus_ischia_dist_buses_section_idx
  ON public.bus_ischia_dist_buses (tenant_id, section, date);
