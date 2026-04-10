-- Fix membership for a real login user on Demo Ischia tenant
-- Usage:
-- 1) Open Supabase Dashboard -> SQL Editor -> New query
-- 2) Paste this file and replace v_email with your login email
-- 3) Run

do $$
declare
  v_email text := 'LA_TUA_EMAIL_DI_LOGIN@...';
  v_role public.app_role := 'operator'; -- change to 'admin' if needed
  v_uid uuid;
  v_tid uuid;
begin
  -- Resolve auth user by email
  select id into v_uid
  from auth.users
  where lower(email) = lower(v_email)
  limit 1;

  if v_uid is null then
    raise exception 'Utente % non trovato in auth.users', v_email;
  end if;

  -- Ensure tenant exists
  select id into v_tid
  from public.tenants
  where name = 'Demo Ischia'
  limit 1;

  if v_tid is null then
    insert into public.tenants(name)
    values ('Demo Ischia')
    returning id into v_tid;
  end if;

  -- Upsert membership
  insert into public.memberships(user_id, tenant_id, role, full_name)
  values (v_uid, v_tid, v_role, 'Operatore Demo')
  on conflict (user_id, tenant_id) do update
  set role = excluded.role,
      full_name = excluded.full_name;
end $$;
