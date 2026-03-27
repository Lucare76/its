create table if not exists public.user_capability_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  capability text not null,
  enabled boolean not null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  unique (tenant_id, user_id, capability)
);

create index if not exists idx_user_capability_overrides_tenant_user
  on public.user_capability_overrides (tenant_id, user_id);

create index if not exists idx_user_capability_overrides_tenant_capability
  on public.user_capability_overrides (tenant_id, capability);

create or replace function public.touch_user_capability_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_user_capability_overrides_updated_at on public.user_capability_overrides;
create trigger trg_user_capability_overrides_updated_at
before update on public.user_capability_overrides
for each row execute procedure public.touch_user_capability_overrides_updated_at();

alter table public.user_capability_overrides enable row level security;

drop policy if exists user_capability_overrides_select_admin on public.user_capability_overrides;
create policy user_capability_overrides_select_admin on public.user_capability_overrides
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);

drop policy if exists user_capability_overrides_insert_admin on public.user_capability_overrides;
create policy user_capability_overrides_insert_admin on public.user_capability_overrides
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);

drop policy if exists user_capability_overrides_update_admin on public.user_capability_overrides;
create policy user_capability_overrides_update_admin on public.user_capability_overrides
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);

drop policy if exists user_capability_overrides_delete_admin on public.user_capability_overrides;
create policy user_capability_overrides_delete_admin on public.user_capability_overrides
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);
