-- Migration 0194: Agency response token per il flusso di conferma agenzia
-- Dopo che l'operatore conferma una prenotazione, viene generato un token
-- monouso inviato all'agenzia via email per registrare l'accettazione.

alter table public.booking_approval_tokens
  add column if not exists agency_token       text          null unique,
  add column if not exists agency_response    text          null
    check (agency_response in ('accepted', 'changes_requested')),
  add column if not exists agency_response_at timestamptz   null,
  add column if not exists agency_response_notes text       null;

create index if not exists idx_booking_approval_tokens_agency_token
  on public.booking_approval_tokens (agency_token)
  where agency_token is not null;
