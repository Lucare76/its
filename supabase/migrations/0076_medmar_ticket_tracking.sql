-- Migration 0076: tracciamento invio biglietti MEDMAR sui servizi

alter table public.services
  add column if not exists medmar_ticket_sent_at timestamptz null,
  add column if not exists medmar_ticket_sent_by uuid null references auth.users(id) on delete set null;

comment on column public.services.medmar_ticket_sent_at is 'Timestamp invio email biglietto MEDMAR/SNAV all''agenzia';
comment on column public.services.medmar_ticket_sent_by is 'Operatore che ha inviato il biglietto';

create index if not exists idx_services_medmar_sent on public.services(tenant_id, medmar_ticket_sent_at)
  where medmar_ticket_sent_at is not null;
