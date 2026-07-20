-- Monitoraggio costi WhatsApp Cloud API basato su status webhook e tariffe configurabili.

alter table public.whatsapp_message_statuses
  add column if not exists billable boolean null,
  add column if not exists pricing_model text null,
  add column if not exists pricing_type text null,
  add column if not exists error_code text null,
  add column if not exists error_message text null;

create table if not exists public.whatsapp_message_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  wamid text not null,
  recipient_phone text null,
  recipient_country_code text null,
  passenger_id uuid null,
  booking_id uuid null references public.services (id) on delete set null,
  template_name text null,
  message_direction text not null default 'outbound' check (message_direction in ('inbound', 'outbound')),
  status text not null,
  status_timestamp timestamptz null,
  sent_at timestamptz null,
  delivered_at timestamptz null,
  read_at timestamptz null,
  failed_at timestamptz null,
  billable boolean null,
  pricing_category text null,
  pricing_model text null,
  pricing_type text null,
  error_code text null,
  error_message text null,
  raw_metadata jsonb not null default '{}'::jsonb,
  applied_rate_id uuid null,
  applied_rate_source text null,
  applied_rate_valid_from date null,
  estimated_cost numeric(12,4) null,
  estimated_currency text not null default 'EUR',
  cost_status text not null default 'pending' check (cost_status in ('pending', 'free', 'estimated', 'missing_rate', 'failed')),
  cost_calculated_at timestamptz null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  unique (tenant_id, wamid)
);

create index if not exists idx_whatsapp_message_events_tenant_status_ts
  on public.whatsapp_message_events (tenant_id, status, status_timestamp desc);
create index if not exists idx_whatsapp_message_events_tenant_delivered
  on public.whatsapp_message_events (tenant_id, delivered_at desc)
  where delivered_at is not null;
create index if not exists idx_whatsapp_message_events_tenant_category
  on public.whatsapp_message_events (tenant_id, pricing_category);
create index if not exists idx_whatsapp_message_events_tenant_country
  on public.whatsapp_message_events (tenant_id, recipient_country_code);
create index if not exists idx_whatsapp_message_events_tenant_booking
  on public.whatsapp_message_events (tenant_id, booking_id)
  where booking_id is not null;
create index if not exists idx_whatsapp_message_events_tenant_created
  on public.whatsapp_message_events (tenant_id, created_at desc);

create table if not exists public.whatsapp_pricing_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  country_code text not null,
  currency text not null default 'EUR',
  pricing_category text not null,
  pricing_type text null,
  pricing_model text null,
  unit_price numeric(12,6) not null check (unit_price >= 0),
  valid_from date not null,
  valid_to date null,
  source text not null default 'manual',
  is_confirmed boolean not null default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  check (valid_to is null or valid_to >= valid_from)
);

create index if not exists idx_whatsapp_pricing_rates_lookup
  on public.whatsapp_pricing_rates (tenant_id, country_code, pricing_category, valid_from desc);
create index if not exists idx_whatsapp_pricing_rates_future
  on public.whatsapp_pricing_rates (tenant_id, valid_from)
  where is_confirmed = false;

create table if not exists public.whatsapp_cost_reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  pricing_category text null,
  pricing_type text null,
  estimated_volume integer not null default 0,
  estimated_cost numeric(12,4) not null default 0,
  meta_reported_volume integer not null default 0,
  meta_reported_cost numeric(12,4) not null default 0,
  difference numeric(12,4) not null default 0,
  source_file text null,
  source_hash text null,
  reconciled_at timestamptz not null default timezone('utc'::text, now()),
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_whatsapp_cost_reconciliations_tenant_period
  on public.whatsapp_cost_reconciliations (tenant_id, period_start desc, period_end desc);

create unique index if not exists uq_whatsapp_cost_reconciliations_period_source
  on public.whatsapp_cost_reconciliations (
    tenant_id,
    period_start,
    period_end,
    pricing_category,
    pricing_type,
    source_hash
  );

create table if not exists public.whatsapp_cost_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  daily_threshold numeric(12,4) not null default 5,
  monthly_threshold numeric(12,4) not null default 100,
  max_avg_messages_per_passenger numeric(8,2) not null default 3,
  anomaly_growth_percent numeric(8,2) not null default 50,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create or replace function public.touch_whatsapp_cost_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_whatsapp_message_events_updated_at on public.whatsapp_message_events;
create trigger trg_whatsapp_message_events_updated_at
before update on public.whatsapp_message_events
for each row execute function public.touch_whatsapp_cost_updated_at();

drop trigger if exists trg_whatsapp_pricing_rates_updated_at on public.whatsapp_pricing_rates;
create trigger trg_whatsapp_pricing_rates_updated_at
before update on public.whatsapp_pricing_rates
for each row execute function public.touch_whatsapp_cost_updated_at();

drop trigger if exists trg_whatsapp_cost_settings_updated_at on public.whatsapp_cost_settings;
create trigger trg_whatsapp_cost_settings_updated_at
before update on public.whatsapp_cost_settings
for each row execute function public.touch_whatsapp_cost_updated_at();

alter table public.whatsapp_message_events enable row level security;
alter table public.whatsapp_pricing_rates enable row level security;
alter table public.whatsapp_cost_reconciliations enable row level security;
alter table public.whatsapp_cost_settings enable row level security;

drop policy if exists whatsapp_message_events_tenant_all on public.whatsapp_message_events;
create policy whatsapp_message_events_tenant_all on public.whatsapp_message_events
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists whatsapp_pricing_rates_tenant_all on public.whatsapp_pricing_rates;
create policy whatsapp_pricing_rates_tenant_all on public.whatsapp_pricing_rates
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists whatsapp_cost_reconciliations_tenant_all on public.whatsapp_cost_reconciliations;
create policy whatsapp_cost_reconciliations_tenant_all on public.whatsapp_cost_reconciliations
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists whatsapp_cost_settings_tenant_all on public.whatsapp_cost_settings;
create policy whatsapp_cost_settings_tenant_all on public.whatsapp_cost_settings
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());
