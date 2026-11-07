alter table public.services
  add column if not exists legacy_import_fingerprint text null;

comment on column public.services.legacy_import_fingerprint is
  'Fingerprint di dedupe scritto SOLO da app/api/excel/import/route.ts (buildImportFingerprint): date+time+direction+hotel_id+customer_name+pax+transport_code+billing_party_name normalizzati. NULL per ogni riga creata da altri flussi (operational-v2, MTS Globe, manuale, round-trip): non partecipano al vincolo di unicita'' sottostante.';

create unique index if not exists uq_services_legacy_import_fingerprint
  on public.services (tenant_id, legacy_import_fingerprint)
  where legacy_import_fingerprint is not null and status <> 'cancelled';