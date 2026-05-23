-- Fix RLS cross-tenant leak su driver_assignment_history e assignment_learned_patterns.
-- Le policy precedenti consentivano accesso tenant troppo ampio, lasciando qualsiasi utente
-- autenticato di leggere/scrivere dati di qualsiasi tenant via REST API.
-- Mantiene idempotenza se 0201/0202 sono gia' stati corretti.

-- ─── driver_assignment_history ───────────────────────────────────────────────

drop policy if exists "tenant_rw" on public.driver_assignment_history;
drop policy if exists dah_select_ops on public.driver_assignment_history;
drop policy if exists dah_insert_ops on public.driver_assignment_history;
drop policy if exists dah_update_ops on public.driver_assignment_history;
drop policy if exists dah_delete_ops on public.driver_assignment_history;

create policy dah_select_ops
  on public.driver_assignment_history
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy dah_insert_ops
  on public.driver_assignment_history
  for insert
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy dah_update_ops
  on public.driver_assignment_history
  for update
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy dah_delete_ops
  on public.driver_assignment_history
  for delete
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

-- ─── assignment_learned_patterns ─────────────────────────────────────────────

drop policy if exists "tenant_rw" on public.assignment_learned_patterns;
drop policy if exists alp_select_ops on public.assignment_learned_patterns;
drop policy if exists alp_insert_ops on public.assignment_learned_patterns;
drop policy if exists alp_update_ops on public.assignment_learned_patterns;
drop policy if exists alp_delete_ops on public.assignment_learned_patterns;

create policy alp_select_ops
  on public.assignment_learned_patterns
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy alp_insert_ops
  on public.assignment_learned_patterns
  for insert
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy alp_update_ops
  on public.assignment_learned_patterns
  for update
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy alp_delete_ops
  on public.assignment_learned_patterns
  for delete
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );
