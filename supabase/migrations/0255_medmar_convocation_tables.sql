-- ============================================================
-- MEDMAR Convocation Tables (standalone WhatsApp bulk sending)
-- Isolated from bus_convocation_* and from medmar-booking ticket
-- issuing domain. Do not mix these tables with either.
-- ============================================================

-- 1. medmar_convocation_batches — one row per uploaded Excel file
create table if not exists public.medmar_convocation_batches (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  created_by    uuid not null,
  file_name     text not null default '',
  label         text not null default '',
  status        text not null default 'draft'
                check (status in ('draft', 'validating', 'ready', 'sending', 'completed', 'error')),
  total_rows    integer not null default 0,
  sent_count    integer not null default 0,
  error_count   integer not null default 0,
  skipped_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_medmar_convocation_batches_tenant
  on public.medmar_convocation_batches (tenant_id, created_at desc);

alter table public.medmar_convocation_batches enable row level security;

create policy medmar_convocation_batches_tenant_all on public.medmar_convocation_batches
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- 2. medmar_convocation_rows — one row per Excel line
create table if not exists public.medmar_convocation_rows (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  batch_id            uuid not null references public.medmar_convocation_batches(id) on delete cascade,
  row_index           integer not null,
  inviare             boolean not null default true,
  phone_raw           text not null default '',
  phone_e164          text null,
  customer_name       text not null default '',
  travel_date         text not null default '',
  route               text not null default '',
  departure_port      text not null default '',
  arrival_port        text not null default '',
  departure_time      text not null default '',
  company             text not null default '',
  passengers          text not null default '',
  booking_reference   text not null default '',
  notes               text not null default '',
  generated_message   text not null default '',
  template_payload    jsonb not null default '{}'::jsonb,
  status              text not null default 'pronto'
                      check (status in (
                        'pronto', 'da_inviare', 'inviato',
                        'errore', 'numero_non_valido', 'duplicato',
                        'escluso', 'da_reinviare'
                      )),
  error_message       text null,
  provider_message_id text null,
  sent_at             timestamptz null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_medmar_convocation_rows_batch
  on public.medmar_convocation_rows (batch_id, row_index);
create index if not exists idx_medmar_convocation_rows_tenant
  on public.medmar_convocation_rows (tenant_id, created_at desc);
create index if not exists idx_medmar_convocation_rows_dedup
  on public.medmar_convocation_rows (tenant_id, phone_e164, travel_date, departure_time);

alter table public.medmar_convocation_rows enable row level security;

create policy medmar_convocation_rows_tenant_all on public.medmar_convocation_rows
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- 3. medmar_convocation_send_logs — detailed per-attempt log
create table if not exists public.medmar_convocation_send_logs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  batch_id            uuid not null references public.medmar_convocation_batches(id) on delete cascade,
  row_id              uuid not null references public.medmar_convocation_rows(id) on delete cascade,
  operator_user_id    uuid not null,
  phone_e164          text not null,
  template_name       text not null,
  language_code       text not null default 'it',
  variables_json      jsonb not null default '{}'::jsonb,
  status              text not null check (status in ('sent', 'failed')),
  provider_message_id text null,
  api_response_json   jsonb null,
  error_message       text null,
  attempt_number      integer not null default 1,
  attempted_at        timestamptz not null default now()
);

create index if not exists idx_medmar_convocation_send_logs_batch
  on public.medmar_convocation_send_logs (batch_id);
create index if not exists idx_medmar_convocation_send_logs_row
  on public.medmar_convocation_send_logs (row_id);

alter table public.medmar_convocation_send_logs enable row level security;

create policy medmar_convocation_send_logs_tenant_all on public.medmar_convocation_send_logs
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
