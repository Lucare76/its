-- Fix: avoid recursive RLS evaluation on memberships via auth helper functions
-- Root cause:
-- - current_tenant_id() reads public.memberships
-- - memberships RLS policies call current_tenant_id()/current_user_role()
-- - this can recurse and raise "stack depth limit exceeded"

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id
  from public.memberships
  where user_id = auth.uid()
  order by created_at asc
  limit 1
$$;

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.memberships
  where user_id = auth.uid()
    and tenant_id = public.current_tenant_id()
  order by created_at asc
  limit 1
$$;

revoke all on function public.current_tenant_id() from public;
grant execute on function public.current_tenant_id() to anon, authenticated, service_role;

revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to anon, authenticated, service_role;
