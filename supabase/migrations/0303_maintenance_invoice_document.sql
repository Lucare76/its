-- Manutenzioni: fattura allegata (un documento per intervento) e indice per i
-- filtri targa/anno.
-- Il file sta nel bucket privato vehicle-documents, sotto
--   <tenant_id>/maintenance/<maintenance_id>/<timestamp>_<nome>
-- Caricamento e apertura passano SOLO dalle API (service role + controllo
-- tenant): non si usano le policy del bucket, che oggi non separano i tenant.
alter table public.vehicle_maintenance
  add column if not exists invoice_document_path text null,
  add column if not exists invoice_document_name text null,
  add column if not exists invoice_uploaded_at timestamptz null,
  add column if not exists invoice_uploaded_by uuid null references auth.users(id) on delete set null;

alter table public.vehicle_maintenance
  drop constraint if exists vehicle_maintenance_invoice_document_check,
  add constraint vehicle_maintenance_invoice_document_check check (
    (invoice_document_path is null and invoice_document_name is null and invoice_uploaded_at is null)
    or (invoice_document_path is not null and invoice_document_name is not null and invoice_uploaded_at is not null
        -- il percorso deve stare nella cartella del proprio tenant e del proprio intervento
        and invoice_document_path like tenant_id::text || '/maintenance/' || id::text || '/%'
        and char_length(invoice_document_path) <= 500 and char_length(invoice_document_name) <= 240)
  );

create index if not exists idx_vehicle_maintenance_tenant_vehicle_date
  on public.vehicle_maintenance(tenant_id, vehicle_id, maintenance_date desc);
create index if not exists idx_vehicle_maintenance_tenant_date
  on public.vehicle_maintenance(tenant_id, maintenance_date desc);
