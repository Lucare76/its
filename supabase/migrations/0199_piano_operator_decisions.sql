-- Persistenza strutturata delle decisioni operative confermate dall'operatore
-- per il Piano del Giorno. Non modifica services, assignments o trip_groups.

create table if not exists public.piano_operator_decisions (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null references public.tenants(id) on delete cascade,
  service_date date not null,

  trip_group_id uuid null references public.trip_groups(id) on delete set null,

  decision_type text not null,
  action text not null,

  suggestion_hash text not null,

  payload_json jsonb not null default '{}'::jsonb,
  before_json jsonb null,
  after_json jsonb null,

  confirmed_by uuid not null references auth.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),

  status text not null default 'confirmed'
    check (status in ('confirmed', 'revoked', 'superseded')),

  revoked_by uuid null references auth.users(id) on delete restrict,
  revoked_at timestamptz null,

  created_at timestamptz not null default now()
);

create index if not exists piano_operator_decisions_tenant_date
  on public.piano_operator_decisions (tenant_id, service_date);

create index if not exists piano_operator_decisions_group
  on public.piano_operator_decisions (tenant_id, trip_group_id);

create unique index if not exists piano_operator_decisions_active_hash
  on public.piano_operator_decisions (tenant_id, service_date, suggestion_hash)
  where status = 'confirmed';

alter table public.piano_operator_decisions enable row level security;

drop policy if exists piano_operator_decisions_select_ops on public.piano_operator_decisions;
drop policy if exists piano_operator_decisions_insert_ops on public.piano_operator_decisions;
drop policy if exists piano_operator_decisions_update_ops on public.piano_operator_decisions;

create policy piano_operator_decisions_select_ops
on public.piano_operator_decisions
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy piano_operator_decisions_insert_ops
on public.piano_operator_decisions
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy piano_operator_decisions_update_ops
on public.piano_operator_decisions
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
