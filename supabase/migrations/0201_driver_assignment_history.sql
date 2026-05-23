-- Storico correzioni operatore → base per apprendimento pattern di assegnazione.
-- Ogni riga cattura un'azione dell'operatore sul risultato dell'auto-assign:
--   auto_assign_accepted  → assegnazione iniziale prodotta dall'algoritmo
--   driver_swap           → operatore ha cambiato autista su un giro
--   vehicle_binding       → operatore ha cambiato mezzo su un giro
--   resolution_suggestion → operatore ha applicato un suggerimento di risoluzione conflitti

create table if not exists public.driver_assignment_history (
  id                      uuid        primary key default gen_random_uuid(),
  tenant_id               uuid        not null,
  service_date            date        not null,
  service_id              uuid,
  group_id                uuid,
  change_type             text        not null
                            check (change_type in (
                              'auto_assign_accepted',
                              'driver_swap',
                              'vehicle_binding',
                              'resolution_suggestion'
                            )),
  from_driver_profile_id  uuid,
  to_driver_profile_id    uuid,
  from_vehicle_label      text,
  to_vehicle_label        text,
  features                jsonb,
  operator_id             uuid        not null,
  created_at              timestamptz not null default now()
);

create index if not exists dah_tenant_date
  on public.driver_assignment_history (tenant_id, service_date);

create index if not exists dah_tenant_driver
  on public.driver_assignment_history (tenant_id, to_driver_profile_id);

create index if not exists dah_change_type
  on public.driver_assignment_history (tenant_id, change_type, service_date);

create index if not exists dah_features_pattern_key
  on public.driver_assignment_history using gin (features);

alter table public.driver_assignment_history enable row level security;

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
