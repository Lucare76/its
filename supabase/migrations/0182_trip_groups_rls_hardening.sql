-- Migration 0168: hardening RLS per trip_groups
-- La tabella era stata introdotta con policy permissive using (true).
-- Allineiamo l'accesso al modello multi-tenant rigoroso per admin/operator.

alter table public.trip_groups enable row level security;

drop policy if exists "tenant_read" on public.trip_groups;
drop policy if exists "tenant_write" on public.trip_groups;
drop policy if exists trip_groups_select_admin_operator on public.trip_groups;
drop policy if exists trip_groups_insert_admin_operator on public.trip_groups;
drop policy if exists trip_groups_update_admin_operator on public.trip_groups;
drop policy if exists trip_groups_delete_admin_operator on public.trip_groups;

create policy trip_groups_select_admin_operator on public.trip_groups
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy trip_groups_insert_admin_operator on public.trip_groups
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy trip_groups_update_admin_operator on public.trip_groups
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy trip_groups_delete_admin_operator on public.trip_groups
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
