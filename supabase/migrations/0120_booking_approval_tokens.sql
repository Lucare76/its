-- Tabella token di approvazione per prenotazioni agenzia
create table if not exists public.booking_approval_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  token text not null unique default gen_random_uuid()::text,
  action text null check (action in ('confirmed', 'rejected')),
  resolved_price_cents integer null check (resolved_price_cents is null or resolved_price_cents >= 0),
  resolved_notes text null,
  resolved_by_email text null,
  expires_at timestamptz not null default (now() + interval '48 hours'),
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_booking_approval_tokens_token on public.booking_approval_tokens (token);
create index if not exists idx_booking_approval_tokens_service on public.booking_approval_tokens (service_id);

-- Colonne approvazione su services
alter table public.services
  add column if not exists approval_status text null
    check (approval_status in ('pending_operator', 'confirmed', 'rejected')),
  add column if not exists approval_price_cents integer null check (approval_price_cents is null or approval_price_cents >= 0),
  add column if not exists approval_notes text null,
  add column if not exists approval_resolved_at timestamptz null;

-- RLS: solo service_role può leggere/scrivere i token
alter table public.booking_approval_tokens enable row level security;

drop policy if exists "service_role_all_booking_approval_tokens" on public.booking_approval_tokens;

create policy "service_role_all_booking_approval_tokens"
  on public.booking_approval_tokens
  for all
  to service_role
  using (true)
  with check (true);
