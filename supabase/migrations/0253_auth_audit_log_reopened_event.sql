-- Adds "access_request_reopened" as an allowed auth_audit_log.event_type so
-- reopening a previously rejected tenant_access_requests row (self-service
-- register, or the "join existing team" access-request flow) can be logged
-- distinctly instead of being folded into the generic "register" event.
-- Purely additive: no existing rows are touched, no values are removed.
--
-- The original CHECK constraint (migration 0090) was created inline without
-- an explicit name, so Postgres auto-generated one. This finds it
-- dynamically instead of hardcoding a guessed name, so the migration is
-- robust regardless of what name Postgres actually picked.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'auth_audit_log'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%event_type%'
  loop
    execute format('alter table public.auth_audit_log drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.auth_audit_log
  add constraint auth_audit_log_event_type_check
  check (event_type in (
    'login',
    'register',
    'reset_password_requested',
    'password_changed',
    'failed_login',
    'session_timeout',
    'logout',
    'account_suspended',
    'account_created_by_admin',
    'access_request_reopened'
  ));
