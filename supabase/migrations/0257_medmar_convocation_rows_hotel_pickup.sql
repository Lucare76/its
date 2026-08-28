-- ADDITIVE ONLY — do not run until reviewed and approved.
-- Adds the two columns the definitive MEDMAR Excel format requires that the
-- original 0255 schema didn't have: hotel and pickup_time ("ora
-- prelevamento"). "ora nave" continues to reuse the existing
-- departure_time column, and pax continues to reuse passengers.
--
-- Legacy columns route / departure_port / arrival_port / company /
-- booking_reference / notes are intentionally left in place (nullable with
-- defaults already) — they are simply no longer required or populated by
-- the upload flow. Removing them is out of scope for this migration.
alter table public.medmar_convocation_rows
  add column if not exists hotel text not null default '';

alter table public.medmar_convocation_rows
  add column if not exists pickup_time text not null default '';
