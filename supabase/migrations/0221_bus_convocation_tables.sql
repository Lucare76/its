-- ============================================================
-- Bus Convocation Tables (standalone WhatsApp bulk sending)
-- Isolated from services, bookings, assignments, planning.
-- ============================================================

-- 1. bus_convocation_batches — one row per uploaded Excel file
create table if not exists public.bus_convocation_batches (
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

create index if not exists idx_bus_convocation_batches_tenant
  on public.bus_convocation_batches (tenant_id, created_at desc);

alter table public.bus_convocation_batches enable row level security;

create policy bus_convocation_batches_tenant_all on public.bus_convocation_batches
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- 2. bus_convocation_rows — one row per Excel line
create table if not exists public.bus_convocation_rows (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  batch_id               uuid not null references public.bus_convocation_batches(id) on delete cascade,
  row_index              integer not null,
  inviare                boolean not null default true,
  phone_raw              text not null default '',
  phone_e164             text null,
  customer_name          text not null default '',
  date_line              text not null default '',
  departure_point        text not null default '',
  driver_name            text not null default '',
  driver_emergency_phone text not null default '',
  generated_message      text not null default '',
  notes                  text not null default '',
  status                 text not null default 'da_validare'
                         check (status in (
                           'da_validare', 'pronto', 'da_inviare', 'inviato',
                           'errore', 'numero_non_valido', 'duplicato',
                           'escluso', 'da_reinviare'
                         )),
  error_message          text null,
  provider_message_id    text null,
  sent_at                timestamptz null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_bus_convocation_rows_batch
  on public.bus_convocation_rows (batch_id, row_index);
create index if not exists idx_bus_convocation_rows_tenant
  on public.bus_convocation_rows (tenant_id, created_at desc);

alter table public.bus_convocation_rows enable row level security;

create policy bus_convocation_rows_tenant_all on public.bus_convocation_rows
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- 3. bus_convocation_send_logs — detailed per-attempt log
create table if not exists public.bus_convocation_send_logs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  batch_id            uuid not null references public.bus_convocation_batches(id) on delete cascade,
  row_id              uuid not null references public.bus_convocation_rows(id) on delete cascade,
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

create index if not exists idx_bus_convocation_send_logs_batch
  on public.bus_convocation_send_logs (batch_id);
create index if not exists idx_bus_convocation_send_logs_row
  on public.bus_convocation_send_logs (row_id);

alter table public.bus_convocation_send_logs enable row level security;

create policy bus_convocation_send_logs_tenant_all on public.bus_convocation_send_logs
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
