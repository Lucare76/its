-- Migration 0132: Cancellation requests with penalty approval flow
-- Adds pending_cancellation status and cancellation_requests table

-- ── 1. Nuovo valore enum status ──────────────────────────────────────────────
alter type public.service_status add value if not exists 'pending_cancellation';

-- ── 2. Tabella cancellation_requests ────────────────────────────────────────
create table if not exists public.cancellation_requests (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  service_id            uuid not null references public.services(id) on delete cascade,

  -- Chi ha richiesto la cancellazione
  requested_by_role     text not null check (requested_by_role in ('agency', 'admin', 'operator')),
  requested_by_user_id  uuid references auth.users(id) on delete set null,

  -- Quale tratta cancellare
  cancel_legs           text not null default 'both' check (cancel_legs in ('arrival', 'departure', 'both')),

  -- Penale (impostata da admin/operatore dopo la richiesta)
  penalty_cents         integer check (penalty_cents >= 0),
  penalty_note          text,

  -- Flusso di approvazione
  -- pending_review          → admin/operatore deve decidere penale
  -- pending_agency_approval → email inviata, attesa risposta agenzia
  -- approved                → agenzia ha accettato, servizio cancellato
  -- rejected                → agenzia ha rifiutato (admin decide il passo successivo)
  -- closed                  → chiuso da admin/operatore (forzato o senza agenzia)
  status                text not null default 'pending_review'
                          check (status in ('pending_review', 'pending_agency_approval', 'approved', 'rejected', 'closed')),

  -- Risposta dell'agenzia
  agency_response       text check (agency_response in ('accepted', 'rejected', 'counter')),
  agency_response_note  text,
  agency_counter_cents  integer check (agency_counter_cents >= 0),
  agency_responded_at   timestamptz,

  -- Token per link email (no login richiesto) — UUID casuale
  approval_token        uuid not null default gen_random_uuid(),

  -- Risoluzione finale
  resolved_at           timestamptz,
  resolved_by_user_id   uuid references auth.users(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Indici utili
create index if not exists cancellation_requests_tenant_id_idx  on public.cancellation_requests(tenant_id);
create index if not exists cancellation_requests_service_id_idx on public.cancellation_requests(service_id);
create index if not exists cancellation_requests_status_idx     on public.cancellation_requests(status);
create index if not exists cancellation_requests_token_idx      on public.cancellation_requests(approval_token);

-- Token deve essere univoco
create unique index if not exists cancellation_requests_token_unique on public.cancellation_requests(approval_token);

-- Trigger updated_at
create or replace function public.set_cancellation_requests_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cancellation_requests_updated_at
  before update on public.cancellation_requests
  for each row execute function public.set_cancellation_requests_updated_at();

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
alter table public.cancellation_requests enable row level security;

-- Admin e operatori del tenant vedono tutto
create policy "cancellation_requests_ops_select" on public.cancellation_requests
  for select using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator')
    )
  );

create policy "cancellation_requests_ops_insert" on public.cancellation_requests
  for insert with check (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator', 'agency')
    )
  );

create policy "cancellation_requests_ops_update" on public.cancellation_requests
  for update using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator')
    )
  );

-- ── 4. Notifiche in-app per agenzie con portale ──────────────────────────────
-- Riusa la tabella notifications se esiste, altrimenti la crea
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete cascade,
  -- null = notifica broadcast per tutti admin/operator del tenant
  role_target     text check (role_target in ('admin', 'operator', 'agency')),
  agency_id       uuid references public.agencies(id) on delete cascade,
  -- null = per agency_id specifico

  type            text not null,
  -- es. 'cancellation_requested', 'cancellation_penalty_set', 'cancellation_resolved'

  title           text not null,
  body            text,
  link            text,
  -- path interno es. /cancellazioni/[request_id]

  reference_id    uuid,
  -- id della cancellation_request o del service

  read            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists notifications_user_id_idx    on public.notifications(user_id);
create index if not exists notifications_agency_id_idx  on public.notifications(agency_id);
create index if not exists notifications_tenant_id_idx  on public.notifications(tenant_id);
create index if not exists notifications_read_idx       on public.notifications(read);

alter table public.notifications enable row level security;

-- Ogni utente vede le proprie notifiche
create policy "notifications_select_own" on public.notifications
  for select using (
    user_id = auth.uid()
    or agency_id in (
      select agency_id from public.memberships
      where user_id = auth.uid() and agency_id is not null
    )
  );

create policy "notifications_update_own" on public.notifications
  for update using (
    user_id = auth.uid()
    or agency_id in (
      select agency_id from public.memberships
      where user_id = auth.uid() and agency_id is not null
    )
  );

-- Service role può inserire notifiche per tutti
create policy "notifications_insert_service" on public.notifications
  for insert with check (true);
