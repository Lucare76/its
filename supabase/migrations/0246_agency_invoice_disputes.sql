-- Contestazione prezzo su un estratto conto già inviato: l'agenzia propone
-- un prezzo diverso su una riga (service_id), ITS (admin/operator/
-- supervisor) approva (applica il prezzo proposto a
-- services.agency_quoted_price_cents) o rifiuta (nessuna modifica).
--
-- Distinta di proposito da services.approval_status/price_mismatch (quel
-- meccanismo scatta quando l'agenzia INSERISCE una nuova prenotazione con un
-- prezzo diverso dal listino interno, ed e' ITS a correggere e notificare —
-- il verso opposto rispetto a questa tabella, dove e' l'agenzia a proporre
-- una correzione su una riga gia' fatturata e ITS ad approvarla).

create table if not exists public.agency_invoice_disputes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  agency_invoice_id uuid null references public.agency_invoices(id) on delete set null,
  service_id uuid not null references public.services(id) on delete cascade,
  original_price_cents integer not null,
  proposed_price_cents integer not null check (proposed_price_cents >= 0),
  agency_note text null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_by uuid null references auth.users(id) on delete set null,
  resolved_at timestamptz null,
  resolution_note text null
);

create index if not exists idx_agency_invoice_disputes_tenant_status
  on public.agency_invoice_disputes(tenant_id, status);

create index if not exists idx_agency_invoice_disputes_tenant_agency
  on public.agency_invoice_disputes(tenant_id, agency_id);

create index if not exists idx_agency_invoice_disputes_service
  on public.agency_invoice_disputes(service_id);

alter table public.agency_invoice_disputes enable row level security;

-- L'accesso applicativo passa sempre dalle route API con service role +
-- filtro esplicito (stesso pattern del resto del repo, vedi CLAUDE.md);
-- queste policy sono difesa in profondita' per eventuale accesso diretto.
create policy "agency_invoice_disputes_agency_select_own"
  on public.agency_invoice_disputes for select
  using (
    agency_id in (
      select agency_id from public.memberships
      where user_id = auth.uid() and role = 'agency' and agency_id is not null
    )
  );

create policy "agency_invoice_disputes_agency_insert_own"
  on public.agency_invoice_disputes for insert
  with check (
    tenant_id in (select tenant_id from public.memberships where user_id = auth.uid())
    and agency_id in (
      select agency_id from public.memberships
      where user_id = auth.uid() and role = 'agency' and agency_id is not null
    )
  );

create policy "agency_invoice_disputes_ops_all"
  on public.agency_invoice_disputes for all
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator', 'supervisor')
    )
  )
  with check (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid() and role in ('admin', 'operator', 'supervisor')
    )
  );

notify pgrst, 'reload schema';
