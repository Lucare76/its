-- ═══════════════════════════════════════════════════════════════════════════
-- 0161 — Vehicle Compliance Override
-- Admin/operatore possono forzare un mezzo operativo nonostante scadenze,
-- con data limite e motivazione obbligatoria. Loggato su compliance_history.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.vehicles
  add column if not exists compliance_override_until  timestamptz null,
  add column if not exists compliance_override_reason text null,
  add column if not exists compliance_override_by     uuid references auth.users(id) on delete set null;

create index if not exists idx_vehicles_compliance_override
  on public.vehicles(tenant_id, compliance_override_until)
  where compliance_override_until is not null;

-- Aggiunge 'overridden' e 'cleared' alle azioni tracciabili nello storico
alter table public.vehicle_compliance_history
  drop constraint if exists vehicle_compliance_history_action_check;

alter table public.vehicle_compliance_history
  add constraint vehicle_compliance_history_action_check
    check (action in ('created', 'renewed', 'archived', 'uploaded', 'overridden', 'cleared'));
