-- Migration: public share token for services

alter table public.services
  add column if not exists share_token text unique null,
  add column if not exists share_expires_at timestamptz null;

create index if not exists idx_services_share_token on public.services (share_token);
create index if not exists idx_services_share_expires_at on public.services (share_expires_at);

