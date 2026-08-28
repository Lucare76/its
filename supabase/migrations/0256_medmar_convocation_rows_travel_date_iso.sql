-- Canonical YYYY-MM-DD form of medmar_convocation_rows.travel_date, so the
-- WhatsApp log can filter by operational departure day without depending on
-- whatever free-text date format the source Excel file used.
alter table public.medmar_convocation_rows
  add column if not exists travel_date_iso date null;

create index if not exists idx_medmar_convocation_rows_travel_date_iso
  on public.medmar_convocation_rows (tenant_id, travel_date_iso);
