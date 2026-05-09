-- Aggiunge campo per il retro del libretto di circolazione.
-- Il fronte usa libretto_document_path / libretto_uploaded_at già esistenti.

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS libretto_document_path_back TEXT,
  ADD COLUMN IF NOT EXISTS libretto_uploaded_at_back   TIMESTAMPTZ;
