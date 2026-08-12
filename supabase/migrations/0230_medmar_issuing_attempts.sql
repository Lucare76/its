-- State machine idempotente per emissione controllata Medmar One Click.

create table if not exists public.medmar_issuing_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  idempotency_key text not null,
  service_ids uuid[] not null,
  status text not null check (status in (
    'preflight_started',
    'preflight_ok',
    'lock_started',
    'locked',
    'booking_started',
    'booked',
    'payment_started',
    'paid',
    'unlock_started',
    'completed',
    'preflight_failed',
    'lock_failed',
    'booking_failed_definitive',
    'payment_failed_definitive',
    'remote_state_unknown',
    'manual_review'
  )),
  preflight_snapshot jsonb null,
  lock_snapshot jsonb null,
  booking_payload_hash text null,
  medmar_id_prenotazione text null,
  medmar_numero text null,
  expected_total_cents integer null,
  final_total_cents integer null,
  last_error_code text null,
  last_error_message text null,
  remote_state_unknown boolean not null default false,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  completed_at timestamptz null,
  unique (tenant_id, idempotency_key)
);

create index if not exists idx_medmar_issuing_attempts_tenant_created
  on public.medmar_issuing_attempts(tenant_id, created_at desc);

create index if not exists idx_medmar_issuing_attempts_tenant_status
  on public.medmar_issuing_attempts(tenant_id, status, updated_at desc);

create index if not exists idx_medmar_issuing_attempts_service_ids
  on public.medmar_issuing_attempts using gin(service_ids);

create table if not exists public.medmar_issuing_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  attempt_id uuid not null references public.medmar_issuing_attempts(id) on delete cascade,
  service_id uuid null references public.services(id) on delete set null,
  previous_status text null,
  new_status text not null,
  event_type text not null,
  medmar_id_prenotazione text null,
  medmar_numero text null,
  error_code text null,
  details jsonb null default '{}'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_medmar_issuing_events_tenant_created
  on public.medmar_issuing_events(tenant_id, created_at desc);

create index if not exists idx_medmar_issuing_events_attempt
  on public.medmar_issuing_events(attempt_id, created_at);

create or replace function public.touch_medmar_issuing_attempts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_medmar_issuing_attempts_updated_at on public.medmar_issuing_attempts;
create trigger trg_medmar_issuing_attempts_updated_at
before update on public.medmar_issuing_attempts
for each row execute function public.touch_medmar_issuing_attempts_updated_at();

alter table public.medmar_issuing_attempts enable row level security;
alter table public.medmar_issuing_events enable row level security;

drop policy if exists medmar_issuing_attempts_select_ops on public.medmar_issuing_attempts;
create policy medmar_issuing_attempts_select_ops on public.medmar_issuing_attempts
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_issuing_attempts_insert_ops on public.medmar_issuing_attempts;
create policy medmar_issuing_attempts_insert_ops on public.medmar_issuing_attempts
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_issuing_attempts_update_ops on public.medmar_issuing_attempts;
create policy medmar_issuing_attempts_update_ops on public.medmar_issuing_attempts
for update using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
) with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_issuing_events_select_ops on public.medmar_issuing_events;
create policy medmar_issuing_events_select_ops on public.medmar_issuing_events
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_issuing_events_insert_ops on public.medmar_issuing_events;
create policy medmar_issuing_events_insert_ops on public.medmar_issuing_events
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
