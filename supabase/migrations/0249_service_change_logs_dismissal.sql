-- Permette di "far sparire" le notifiche del Centro notifiche una volta
-- viste/gestite (app/(app)/notifications/page.tsx, che legge
-- service_change_logs — vedi migration 0232). Il log di audit resta intatto
-- (nessuna riga viene mai cancellata): si aggiunge solo lo stato di
-- dismissal, condiviso per tutto il tenant (chi gestisce una notifica la
-- fa sparire per tutto il team, coerente con un centro notifiche operativo
-- condiviso, non una inbox personale).

alter table public.service_change_logs
  add column if not exists dismissed_at timestamptz null,
  add column if not exists dismissed_by_user_id uuid null references auth.users(id) on delete set null;

create index if not exists idx_service_change_logs_tenant_dismissed
  on public.service_change_logs (tenant_id, dismissed_at);

drop policy if exists service_change_logs_update_ops on public.service_change_logs;
create policy service_change_logs_update_ops on public.service_change_logs
for update using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
) with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
