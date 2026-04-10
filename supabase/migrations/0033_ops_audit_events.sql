create table if not exists public.ops_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  event text not null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  user_id uuid null references auth.users (id) on delete set null,
  role text null,
  service_id uuid null references public.services (id) on delete set null,
  inbound_email_id uuid null references public.inbound_emails (id) on delete set null,
  duplicate boolean not null default false,
  outcome text null,
  parser_key text null,
  parsing_quality text null,
  details jsonb null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_audit_events_tenant_created_at on public.ops_audit_events (tenant_id, created_at desc);
create index if not exists idx_ops_audit_events_tenant_event on public.ops_audit_events (tenant_id, event, created_at desc);

alter table public.ops_audit_events enable row level security;

drop policy if exists ops_audit_events_select_admin_operator on public.ops_audit_events;
drop policy if exists ops_audit_events_insert_system on public.ops_audit_events;
drop policy if exists ops_audit_events_delete_admin on public.ops_audit_events;

create policy ops_audit_events_select_admin_operator on public.ops_audit_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy ops_audit_events_insert_system on public.ops_audit_events
for insert
with check (tenant_id = public.current_tenant_id());

create policy ops_audit_events_delete_admin on public.ops_audit_events
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);
