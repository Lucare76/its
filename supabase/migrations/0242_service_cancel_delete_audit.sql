-- Estende il log di eliminazione definitiva prenotazioni con ruolo e motivo.

alter table public.service_deletion_log
  add column if not exists deleted_by_role text,
  add column if not exists deletion_reason text;

create index if not exists idx_service_deletion_log_tenant_reason
  on public.service_deletion_log(tenant_id, deletion_reason, deleted_at desc);
