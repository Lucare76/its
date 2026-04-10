-- Create direct_invites table for admin to invite users directly
create table if not exists public.direct_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invited_by_user_id uuid not null references auth.users(id) on delete set null,
  email text not null,
  full_name text not null,
  role text not null check (role in ('admin', 'operator', 'driver', 'agency')),
  agency_id uuid references public.agencies(id) on delete set null,
  invite_token text unique not null,
  expires_at timestamp with time zone not null,
  accepted_at timestamp with time zone,
  rejected_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

-- Create indexes
create index if not exists idx_direct_invites_tenant_id on public.direct_invites(tenant_id);
create index if not exists idx_direct_invites_email on public.direct_invites(email);
create index if not exists idx_direct_invites_token on public.direct_invites(invite_token);
create index if not exists idx_direct_invites_expires_at on public.direct_invites(expires_at);

-- Enable RLS
alter table public.direct_invites enable row level security;

-- RLS Policy: Users can view invites sent to them
create policy "Users can view own invites"
  on public.direct_invites
  for select
  using (email = (select email from auth.users where id = auth.uid()));

-- RLS Policy: Admins can view all invites for their tenant
create policy "Admin can view tenant invites"
  on public.direct_invites
  for select
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role = 'admin'
    )
  );

-- RLS Policy: Service role can manage invites
create policy "Service role can manage invites"
  on public.direct_invites
  for all
  using (true)
  with check (true);
