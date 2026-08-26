-- Motore di scheduling operativo (Assegnazione Intelligente) — persistenza del
-- piano giornaliero proposto. Non duplica lib/piano-auto-assign-planner.ts /
-- lib/piano-assignable-service.ts (che restano l'unica fonte di verita' per
-- vincoli/scoring/missioni): questa tabella persiste solo la CLASSIFICAZIONE
-- risultante (auto_safe/review/unresolved/locked/manual) per servizio, cosi'
-- che Mario veda un piano stabile invece di una preview ricalcolata ad ogni
-- richiesta, e possa confermare in massa / bloccare / riassegnare.
--
-- Un piano per (tenant, data): il "RICALCOLA PIANO" aggiorna la stessa riga
-- (nuovo generated_at/duration_ms) e sostituisce gli item non lockati.

create table if not exists public.assignment_plans (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null,
  plan_date             date        not null,
  status                text        not null default 'ready'
                          check (status in ('generating', 'ready', 'error')),
  generated_by          uuid,
  generated_at          timestamptz not null default now(),
  duration_ms           int,
  services_count        int         not null default 0,
  auto_safe_count       int         not null default 0,
  review_count          int         not null default 0,
  unresolved_count      int         not null default 0,
  locked_count          int         not null default 0,
  manual_count          int         not null default 0,
  drivers_count         int         not null default 0,
  vehicles_count        int         not null default 0,
  summary               jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint assignment_plans_unique_tenant_date unique (tenant_id, plan_date)
);

create index if not exists ap_tenant_date
  on public.assignment_plans (tenant_id, plan_date);

alter table public.assignment_plans enable row level security;

create policy ap_select_ops
  on public.assignment_plans
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy ap_insert_ops
  on public.assignment_plans
  for insert
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy ap_update_ops
  on public.assignment_plans
  for update
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy ap_delete_ops
  on public.assignment_plans
  for delete
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

-- Un item per servizio nel piano corrente. "locked" e' un flag esplicito
-- dell'operatore (its.lock_assignment / azione UI "blocca"), indipendente da
-- assignments.locked_by_operator (che oggi vale true per QUALSIASI scrittura
-- manuale/MCP, vedi lib/server/assign-service-core.ts) — cosi' il piano puo'
-- distinguere "proposta bloccata da Mario prima di confermarla" da "servizio
-- gia' assegnato manualmente in precedenza" (status 'manual').
create table if not exists public.assignment_plan_items (
  id                      uuid        primary key default gen_random_uuid(),
  plan_id                 uuid        not null references public.assignment_plans(id) on delete cascade,
  tenant_id               uuid        not null,
  service_id              uuid        not null,
  status                  text        not null
                            check (status in ('auto_safe', 'review', 'unresolved', 'locked', 'manual')),
  proposed_driver_id      uuid,
  proposed_driver_name    text,
  proposed_vehicle_id     uuid,
  proposed_vehicle_label  text,
  mission_group_key       text,
  score                   numeric,
  confidence              numeric,
  reason                  jsonb,
  alternatives            jsonb,
  warnings                jsonb,
  suggested_fix           jsonb,
  locked                  boolean     not null default false,
  confirmed_at            timestamptz,
  confirmed_by            uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint assignment_plan_items_unique unique (plan_id, service_id)
);

create index if not exists api_tenant_plan
  on public.assignment_plan_items (tenant_id, plan_id);

create index if not exists api_tenant_service
  on public.assignment_plan_items (tenant_id, service_id);

create index if not exists api_plan_status
  on public.assignment_plan_items (plan_id, status);

create index if not exists api_plan_driver
  on public.assignment_plan_items (plan_id, proposed_driver_id);

alter table public.assignment_plan_items enable row level security;

create policy api_select_ops
  on public.assignment_plan_items
  for select
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy api_insert_ops
  on public.assignment_plan_items
  for insert
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy api_update_ops
  on public.assignment_plan_items
  for update
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy api_delete_ops
  on public.assignment_plan_items
  for delete
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );
