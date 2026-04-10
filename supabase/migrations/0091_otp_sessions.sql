-- Create OTP sessions table for 2FA
create table if not exists public.otp_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  otp_code text not null,
  attempts_remaining int default 3,
  expires_at timestamp with time zone not null,
  verified_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

-- Create indexes
create index idx_otp_sessions_user_id on public.otp_sessions(user_id);
create index idx_otp_sessions_email on public.otp_sessions(email);
create index idx_otp_sessions_expires_at on public.otp_sessions(expires_at);

-- Enable RLS
alter table public.otp_sessions enable row level security;

-- RLS Policy: Users can view their own OTP sessions
create policy "Users can view own OTP sessions"
  on public.otp_sessions
  for select
  using (user_id = auth.uid());

-- RLS Policy: Service role can manage OTP sessions
create policy "Service role can manage OTP sessions"
  on public.otp_sessions
  for all
  using (true)
  with check (true);
