-- Operations Suggestions Engine: resolved/generated suggestion ledger.
create table if not exists public.operations_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  suggestion_id text not null,
  type text not null,
  action_payload jsonb not null default '{}'::jsonb,
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, suggestion_id)
);

alter table public.operations_suggestions enable row level security;

drop policy if exists operations_suggestions_select_admin_operator on public.operations_suggestions;
drop policy if exists operations_suggestions_insert_admin_operator on public.operations_suggestions;
drop policy if exists operations_suggestions_update_admin_operator on public.operations_suggestions;

create policy operations_suggestions_select_admin_operator on public.operations_suggestions
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy operations_suggestions_insert_admin_operator on public.operations_suggestions
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create policy operations_suggestions_update_admin_operator on public.operations_suggestions
for update using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
) with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

create or replace function public.set_operations_suggestions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_operations_suggestions_updated_at on public.operations_suggestions;
create trigger trg_operations_suggestions_updated_at
before update on public.operations_suggestions
for each row execute function public.set_operations_suggestions_updated_at();
