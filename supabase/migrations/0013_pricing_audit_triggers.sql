-- Migration: audit versioning for price_lists and pricing_rules

create table if not exists public.pricing_audits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  entity_type text not null check (entity_type in ('price_list', 'pricing_rule')),
  entity_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_row jsonb null,
  new_row jsonb null,
  actor_user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pricing_audits_tenant_created on public.pricing_audits (tenant_id, created_at desc);
create index if not exists idx_pricing_audits_entity on public.pricing_audits (entity_type, entity_id, created_at desc);

create or replace function public.log_pricing_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_entity_type text;
  v_entity_id uuid;
begin
  if TG_TABLE_NAME = 'price_lists' then
    v_entity_type := 'price_list';
  elsif TG_TABLE_NAME = 'pricing_rules' then
    v_entity_type := 'pricing_rule';
  else
    return coalesce(new, old);
  end if;

  v_tenant_id := coalesce(new.tenant_id, old.tenant_id);
  v_entity_id := coalesce(new.id, old.id);

  insert into public.pricing_audits (
    tenant_id,
    entity_type,
    entity_id,
    action,
    old_row,
    new_row,
    actor_user_id
  )
  values (
    v_tenant_id,
    v_entity_type,
    v_entity_id,
    lower(TG_OP),
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(new) else null end,
    auth.uid()
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_price_lists_audit on public.price_lists;
create trigger trg_price_lists_audit
after insert or update or delete on public.price_lists
for each row execute function public.log_pricing_audit();

drop trigger if exists trg_pricing_rules_audit on public.pricing_rules;
create trigger trg_pricing_rules_audit
after insert or update or delete on public.pricing_rules
for each row execute function public.log_pricing_audit();

alter table public.pricing_audits enable row level security;

drop policy if exists pricing_audits_select_admin_operator on public.pricing_audits;
drop policy if exists pricing_audits_insert_system on public.pricing_audits;
drop policy if exists pricing_audits_delete_admin on public.pricing_audits;

create policy pricing_audits_select_admin_operator on public.pricing_audits
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy pricing_audits_insert_system on public.pricing_audits
for insert
with check (tenant_id = public.current_tenant_id());

create policy pricing_audits_delete_admin on public.pricing_audits
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'admin'
);

