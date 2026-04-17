-- Migration 0133: Modification requests — agency requests changes, ops approves/rejects

create table if not exists public.modification_requests (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  service_id            uuid not null references public.services(id) on delete cascade,
  requested_by_user_id  uuid references auth.users(id) on delete set null,

  -- Campi richiesti (solo quelli che l'agenzia vuole cambiare)
  -- Struttura: { arrival_date?, arrival_time?, departure_date?, departure_time?,
  --              pax?, hotel_id?, booking_service_kind?, notes? }
  changes               jsonb not null default '{}',

  -- Valori originali al momento della richiesta (per confronto)
  original_values       jsonb not null default '{}',

  -- pending   → in attesa di risposta ops
  -- approved  → ops ha approvato e applicato le modifiche
  -- rejected  → ops ha rifiutato
  status                text not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected')),

  operator_notes        text,
  resolved_at           timestamptz,
  resolved_by_user_id   uuid references auth.users(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists modification_requests_tenant_id_idx  on public.modification_requests(tenant_id);
create index if not exists modification_requests_service_id_idx on public.modification_requests(service_id);
create index if not exists modification_requests_status_idx     on public.modification_requests(status);

create or replace function public.set_modification_requests_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger modification_requests_updated_at
  before update on public.modification_requests
  for each row execute function public.set_modification_requests_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.modification_requests enable row level security;

-- Admin e operatori vedono tutto il tenant
create policy "modification_requests_ops_select" on public.modification_requests
  for select using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator')
    )
  );

create policy "modification_requests_ops_update" on public.modification_requests
  for update using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator')
    )
  );

-- Agenzie possono inserire e vedere le proprie richieste
create policy "modification_requests_agency_insert" on public.modification_requests
  for insert with check (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role = 'agency'
    )
  );

create policy "modification_requests_agency_select" on public.modification_requests
  for select using (
    requested_by_user_id = auth.uid()
  );
