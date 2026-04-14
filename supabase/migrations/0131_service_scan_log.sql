-- Log scansioni QR per smarcamento servizi al porto.
-- Registra ogni scansione: chi, quando, esito (view / complete / double_attempt).

create table if not exists public.service_scan_log (
  id                  uuid        default gen_random_uuid() primary key,
  tenant_id           uuid        not null,
  service_id          uuid        not null,
  scanned_by_user_id  uuid,
  scanned_at          timestamptz not null default now(),
  action              text        not null
                        check (action in ('view','complete','double_complete_attempt'))
);

create index if not exists service_scan_log_service
  on public.service_scan_log (service_id, scanned_at desc);
create index if not exists service_scan_log_tenant
  on public.service_scan_log (tenant_id, scanned_at desc);
