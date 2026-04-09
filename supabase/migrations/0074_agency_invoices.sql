-- Migration 0074: impostazioni estratto conto per agenzia + tabella fatture

-- Aggiungi colonne di configurazione estratto conto alla tabella agencies
alter table public.agencies
  add column if not exists invoice_email text null,
  add column if not exists invoice_cadence text not null default 'weekly'
    check (invoice_cadence in ('weekly', 'biweekly', 'monthly')),
  add column if not exists invoice_send_day smallint not null default 1
    check (invoice_send_day between 0 and 6),
  add column if not exists invoice_enabled boolean not null default false;

-- Tabella estratti conto inviati
create table if not exists public.agency_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agency_id uuid null references public.agencies(id) on delete set null,
  agency_name text not null,
  period_from date not null,
  period_to date not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid')),
  total_cents integer not null default 0,
  services_count integer not null default 0,
  invoice_data jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz null,
  paid_at timestamptz null,
  paid_by_user_id uuid null references auth.users(id) on delete set null,
  payment_note text null
);

create index if not exists idx_agency_invoices_tenant on public.agency_invoices(tenant_id);
create index if not exists idx_agency_invoices_agency on public.agency_invoices(agency_id);
create index if not exists idx_agency_invoices_status on public.agency_invoices(tenant_id, status);
create index if not exists idx_agency_invoices_period on public.agency_invoices(tenant_id, period_from, period_to);

-- RLS
alter table public.agency_invoices enable row level security;

create policy "agency_invoices_tenant_read"
  on public.agency_invoices for select
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid()
    )
  );

create policy "agency_invoices_admin_write"
  on public.agency_invoices for all
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator')
    )
  );
