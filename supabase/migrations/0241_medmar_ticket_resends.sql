-- Ledger dei reinvii "Rimanda biglietto" (MVP sicuro): un reinvio non crea
-- una nuova emissione ne' chiama lock/booking/payment, si limita a
-- recuperare di nuovo lo stesso PDF gia' pulito/validato dalla mailbox
-- (via pdf_mailbox_message_uid gia' salvato) e a rispedirlo allo stesso
-- destinatario gia' usato in medmar_delivery_attempts.recipient_email.
--
-- Scrittura solo server-side (service role): nessuna policy insert/update
-- per i ruoli applicativi, coerente con "server-side/service role" richiesto
-- — la sola select serve a mostrare lo storico reinvii in UI.

create table if not exists public.medmar_ticket_resends (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  delivery_attempt_id uuid not null references public.medmar_delivery_attempts(id) on delete cascade,
  issuing_attempt_id uuid null references public.medmar_issuing_attempts(id) on delete set null,
  medmar_id_prenotazione text not null,
  medmar_numero text not null,
  recipient_email text not null,
  resend_message_id text null,
  status text not null check (status in ('started', 'sent', 'failed')),
  error_code text null,
  error_message text null,
  pdf_cleaned_sha256 text null,
  original_pdf_sha256 text null,
  hash_warning boolean not null default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  created_by uuid null references auth.users(id) on delete set null,
  sent_at timestamptz null
);

create index if not exists idx_medmar_ticket_resends_tenant_delivery_attempt
  on public.medmar_ticket_resends(tenant_id, delivery_attempt_id, created_at desc);

alter table public.medmar_ticket_resends enable row level security;

drop policy if exists medmar_ticket_resends_select_ops on public.medmar_ticket_resends;
create policy medmar_ticket_resends_select_ops on public.medmar_ticket_resends
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
