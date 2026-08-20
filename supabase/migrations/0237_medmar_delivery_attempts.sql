-- State machine idempotente per la delivery email del PDF Medmar pulito,
-- successiva e distinta dall'emissione (medmar_issuing_attempts): un
-- issuing_attempt "completed" puo' avere UN SOLO delivery_attempt (unique su
-- issuing_attempt_id), aggiornato in place mentre attraversa gli stati.
--
-- Stati positivi: awaiting_pdf, pdf_found, pdf_cleaned, delivery_started,
-- delivered (terminale). Stati errore/revisione manuale: pdf_not_found
-- (unico ritentabile in sicurezza), pdf_ambiguous, pdf_validation_failed,
-- recipient_missing, delivery_failed, delivery_state_unknown, manual_review.

create table if not exists public.medmar_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  issuing_attempt_id uuid not null references public.medmar_issuing_attempts(id) on delete cascade,
  service_ids uuid[] not null,
  status text not null check (status in (
    'awaiting_pdf',
    'pdf_found',
    'pdf_cleaned',
    'delivery_started',
    'delivered',
    'pdf_not_found',
    'pdf_ambiguous',
    'pdf_validation_failed',
    'recipient_missing',
    'delivery_failed',
    'delivery_state_unknown',
    'manual_review'
  )),
  medmar_id_prenotazione text null,
  medmar_numero text null,
  pdf_mailbox_message_uid text null,
  pdf_filename text null,
  pdf_original_sha256 text null,
  pdf_cleaned_sha256 text null,
  recipient_type text null check (recipient_type in ('agency', 'customer')),
  recipient_name text null,
  recipient_email text null,
  resend_message_id text null,
  attempt_count integer not null default 0,
  last_error_code text null,
  last_error_message text null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  delivered_at timestamptz null,
  unique (tenant_id, issuing_attempt_id)
);

create index if not exists idx_medmar_delivery_attempts_tenant_status
  on public.medmar_delivery_attempts(tenant_id, status, updated_at desc);

create index if not exists idx_medmar_delivery_attempts_service_ids
  on public.medmar_delivery_attempts using gin(service_ids);

-- Riusa la funzione trigger generica gia' creata da 0230 (nessuna logica
-- specifica alla tabella, solo `new.updated_at = now()`).
drop trigger if exists trg_medmar_delivery_attempts_updated_at on public.medmar_delivery_attempts;
create trigger trg_medmar_delivery_attempts_updated_at
before update on public.medmar_delivery_attempts
for each row execute function public.touch_medmar_issuing_attempts_updated_at();

alter table public.medmar_delivery_attempts enable row level security;

drop policy if exists medmar_delivery_attempts_select_ops on public.medmar_delivery_attempts;
create policy medmar_delivery_attempts_select_ops on public.medmar_delivery_attempts
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_delivery_attempts_insert_ops on public.medmar_delivery_attempts;
create policy medmar_delivery_attempts_insert_ops on public.medmar_delivery_attempts
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_delivery_attempts_update_ops on public.medmar_delivery_attempts;
create policy medmar_delivery_attempts_update_ops on public.medmar_delivery_attempts
for update using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
) with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
