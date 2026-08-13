-- Audit piu robusto per suggerimenti archiviati e modifiche prenotazioni.

alter table public.operations_suggestions
  add column if not exists resolved_by_name text,
  add column if not exists resolution_note text,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists restored_by_name text,
  add column if not exists restore_note text;

create table if not exists public.service_change_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  root_service_id uuid null references public.services(id) on delete set null,
  action text not null default 'updated',
  changed_fields text[] not null default '{}'::text[],
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  operator_user_id uuid references auth.users(id) on delete set null,
  operator_name text,
  operator_email text,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_service_change_logs_tenant_service_created
  on public.service_change_logs (tenant_id, service_id, created_at desc);

create index if not exists idx_service_change_logs_tenant_created
  on public.service_change_logs (tenant_id, created_at desc);

alter table public.service_change_logs enable row level security;

drop policy if exists service_change_logs_select_ops on public.service_change_logs;
create policy service_change_logs_select_ops on public.service_change_logs
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists service_change_logs_insert_ops on public.service_change_logs;
create policy service_change_logs_insert_ops on public.service_change_logs
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
