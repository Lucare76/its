-- ADDITIVE ONLY — do not run until reviewed and approved.
-- Adds the canonical booking identity to medmar_convocation_rows so a
-- generated-from-services convocation can be re-identified across days even
-- if phone/pickup/hotel/pax/vessel_time later change on the service. Rows
-- created from historic Excel batches keep service_id = null; they are never
-- backfilled and never blocked by this column.
alter table public.medmar_convocation_rows
  add column if not exists service_id uuid null references public.services(id) on delete set null;

create index if not exists idx_medmar_convocation_rows_service_id
  on public.medmar_convocation_rows (tenant_id, service_id);
