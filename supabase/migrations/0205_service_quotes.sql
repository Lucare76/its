-- Migration 0205: preventivi transfer clienti (service_quotes)
-- Flusso: draft → offer_sent → accepted → paid → confirmed | expired | cancelled

-- ── Configurazione tenant per preventivi ────────────────────────────────────
alter table public.tenants
  add column if not exists quote_iban                    text,
  add column if not exists quote_bank_holder             text,
  add column if not exists quote_payment_instructions    text,
  add column if not exists quote_company_phone           text,
  add column if not exists quote_company_whatsapp        text,
  add column if not exists quote_offer_validity_days     integer not null default 7,
  add column if not exists quote_sequence                integer not null default 0;

-- ── Tabella preventivi ───────────────────────────────────────────────────────
create table if not exists public.service_quotes (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete cascade,
  quote_number            text not null,             -- es. "QT-2026-0001"

  -- CLIENTE
  customer_first_name     text not null,
  customer_last_name      text not null,
  customer_email          text not null,
  customer_phone          text,
  customer_language       text not null default 'it', -- 'it' | 'en'

  -- SERVIZIO
  service_type            text not null,
  -- 'transfer_airport' | 'transfer_station' | 'transfer_port'
  -- 'excursion' | 'shuttle' | 'formula_snav' | 'formula_medmar' | 'custom'

  direction               text,
  -- 'arrival' | 'departure' | 'round_trip' | null

  arrival_date            date,
  arrival_time            time,
  arrival_flight_train    text,

  departure_date          date,
  departure_time          time,
  departure_flight_train  text,

  hotel_name              text,
  hotel_address           text,
  pax                     integer not null default 1,
  luggage_notes           text,
  special_requests        text,

  -- PREZZO
  price_cents             integer not null,           -- prezzo PER PERSONA in centesimi
  currency                text not null default 'EUR',
  price_notes             text,

  -- TESTO EMAIL PERSONALIZZATO
  email_intro             text,                       -- messaggio apertura custom (opz.)

  -- PAGAMENTO
  payment_method          text,                       -- 'bank_transfer' | 'cash' | 'card' | 'other'
  iban                    text,
  bank_account_holder     text,
  payment_instructions    text,
  payment_reference       text,                       -- es. CRO bonifico registrato

  -- STATI
  status                  text not null default 'draft'
    check (status in ('draft','offer_sent','accepted','paid','confirmed','expired','cancelled')),

  -- TOKEN ACCETTAZIONE
  accept_token            uuid not null default gen_random_uuid() unique,
  accept_token_expires_at timestamptz,
  accepted_at             timestamptz,
  accepted_ip             text,

  -- TIMESTAMP CICLO DI VITA
  offer_sent_at           timestamptz,
  paid_at                 timestamptz,
  confirmed_at            timestamptz,
  cancelled_at            timestamptz,
  expires_at              timestamptz,               -- scadenza offerta (visibile al cliente)

  -- COLLEGAMENTO SERVIZIO (dopo conferma)
  service_id              uuid references public.services (id) on delete set null,

  -- OPERATORE
  created_by              uuid references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- NOTE INTERNE
  notes_internal          text                        -- MAI visibili al cliente
);

-- ── Indici ───────────────────────────────────────────────────────────────────
create index if not exists idx_service_quotes_tenant_status
  on public.service_quotes (tenant_id, status);
create index if not exists idx_service_quotes_accept_token
  on public.service_quotes (accept_token);
create index if not exists idx_service_quotes_email
  on public.service_quotes (customer_email);
create index if not exists idx_service_quotes_tenant_created
  on public.service_quotes (tenant_id, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.service_quotes enable row level security;

drop policy if exists service_quotes_tenant_all on public.service_quotes;
create policy service_quotes_tenant_all
  on public.service_quotes
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ── Funzione generazione numero progressivo ───────────────────────────────────
create or replace function public.next_quote_number(p_tenant_id uuid)
returns text
language plpgsql
security definer
as $$
declare
  v_seq integer;
  v_year text;
begin
  v_year := to_char(now(), 'YYYY');
  update public.tenants
    set quote_sequence = quote_sequence + 1
    where id = p_tenant_id
    returning quote_sequence into v_seq;
  return 'QT-' || v_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;
