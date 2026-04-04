-- Create auth_audit_log table for tracking authentication events
create table if not exists public.auth_audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in ('login', 'register', 'reset_password_requested', 'password_changed', 'failed_login', 'session_timeout', 'logout', 'account_suspended', 'account_created_by_admin')),
  status text not null check (status in ('success', 'failed')),
  ip_address inet,
  user_agent text,
  details jsonb default '{}',
  created_at timestamp with time zone default now()
);

-- Create index for efficient filtering
create index idx_auth_audit_log_user_id on public.auth_audit_log(user_id);
create index idx_auth_audit_log_tenant_id on public.auth_audit_log(tenant_id);
create index idx_auth_audit_log_event_type on public.auth_audit_log(event_type);
create index idx_auth_audit_log_created_at on public.auth_audit_log(created_at);

-- Enable RLS
alter table public.auth_audit_log enable row level security;

-- RLS Policy: Users can view their own audit log entries
create policy "Users can view own audit log"
  on public.auth_audit_log
  for select
  using (
    user_id = auth.uid()
  );

-- RLS Policy: Admins can view all audit log entries for their tenant
create policy "Admin can view tenant audit log"
  on public.auth_audit_log
  for select
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role = 'admin'
    )
    or (tenant_id is null and auth.uid() in (
      select id from auth.users where email like '%.admin@%'
    ))
  );

-- RLS Policy: Service role can insert audit logs
create policy "Service role can insert audit logs"
  on public.auth_audit_log
  for insert
  with check (true);
