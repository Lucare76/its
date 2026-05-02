-- WhatsApp Cloud API inbound inbox and webhook archive.

create table if not exists public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null references public.tenants (id) on delete set null,
  provider text not null default 'meta',
  event_type text null,
  object text null,
  raw_payload jsonb not null,
  signature_valid boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  processing_error text null,
  dedupe_key text null unique
);

create index if not exists idx_whatsapp_webhook_events_tenant_received_at
  on public.whatsapp_webhook_events (tenant_id, received_at desc);
create index if not exists idx_whatsapp_webhook_events_received_at
  on public.whatsapp_webhook_events (received_at desc);
create index if not exists idx_whatsapp_webhook_events_event_type
  on public.whatsapp_webhook_events (event_type);

create table if not exists public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  wa_id text not null,
  phone_e164 text null,
  profile_name text null,
  customer_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, wa_id)
);

create index if not exists idx_whatsapp_contacts_tenant_phone
  on public.whatsapp_contacts (tenant_id, phone_e164);
create index if not exists idx_whatsapp_contacts_tenant_wa
  on public.whatsapp_contacts (tenant_id, wa_id);

create table if not exists public.whatsapp_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  wa_id text not null,
  phone_e164 text null,
  contact_id uuid null references public.whatsapp_contacts (id) on delete set null,
  customer_id uuid null,
  booking_id uuid null references public.services (id) on delete set null,
  transfer_id uuid null references public.services (id) on delete set null,
  last_message_at timestamptz null,
  last_message_preview text null,
  unread_count integer not null default 0 check (unread_count >= 0),
  assigned_to uuid null references auth.users (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'needs_review', 'closed')),
  match_status text not null default 'unmatched' check (match_status in ('matched', 'unmatched', 'ambiguous', 'needs_review')),
  match_suggestions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, wa_id)
);

create index if not exists idx_whatsapp_threads_tenant_wa
  on public.whatsapp_threads (tenant_id, wa_id);
create index if not exists idx_whatsapp_threads_tenant_phone
  on public.whatsapp_threads (tenant_id, phone_e164);
create index if not exists idx_whatsapp_threads_tenant_booking
  on public.whatsapp_threads (tenant_id, booking_id);
create index if not exists idx_whatsapp_threads_tenant_transfer
  on public.whatsapp_threads (tenant_id, transfer_id);
create index if not exists idx_whatsapp_threads_tenant_last_message
  on public.whatsapp_threads (tenant_id, last_message_at desc);
create index if not exists idx_whatsapp_threads_tenant_status
  on public.whatsapp_threads (tenant_id, status);
create index if not exists idx_whatsapp_threads_tenant_unread
  on public.whatsapp_threads (tenant_id, unread_count);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  wa_message_id text null,
  direction text not null check (direction in ('inbound', 'outbound')),
  wa_id text not null,
  phone_e164 text null,
  contact_id uuid null references public.whatsapp_contacts (id) on delete set null,
  thread_id uuid null references public.whatsapp_threads (id) on delete set null,
  customer_id uuid null,
  booking_id uuid null references public.services (id) on delete set null,
  transfer_id uuid null references public.services (id) on delete set null,
  message_type text null,
  text_body text null,
  media_id text null,
  media_mime_type text null,
  media_sha256 text null,
  status text null,
  timestamp timestamptz null,
  raw_message jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, wa_message_id)
);

create index if not exists idx_whatsapp_messages_tenant_created
  on public.whatsapp_messages (tenant_id, created_at desc);
create index if not exists idx_whatsapp_messages_tenant_thread_created
  on public.whatsapp_messages (tenant_id, thread_id, created_at asc);
create index if not exists idx_whatsapp_messages_tenant_wa
  on public.whatsapp_messages (tenant_id, wa_id);
create index if not exists idx_whatsapp_messages_tenant_phone
  on public.whatsapp_messages (tenant_id, phone_e164);
create index if not exists idx_whatsapp_messages_tenant_booking
  on public.whatsapp_messages (tenant_id, booking_id);
create index if not exists idx_whatsapp_messages_tenant_transfer
  on public.whatsapp_messages (tenant_id, transfer_id);

create table if not exists public.whatsapp_message_statuses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  wa_message_id text not null,
  status text not null,
  recipient_id text null,
  conversation_id text null,
  pricing_category text null,
  timestamp timestamptz null,
  raw_status jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, wa_message_id, status, timestamp)
);

create index if not exists idx_whatsapp_message_statuses_tenant_message
  on public.whatsapp_message_statuses (tenant_id, wa_message_id);
create index if not exists idx_whatsapp_message_statuses_tenant_created
  on public.whatsapp_message_statuses (tenant_id, created_at desc);

alter table public.whatsapp_webhook_events enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_threads enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_message_statuses enable row level security;

drop policy if exists whatsapp_contacts_tenant_all on public.whatsapp_contacts;
create policy whatsapp_contacts_tenant_all on public.whatsapp_contacts
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists whatsapp_threads_tenant_all on public.whatsapp_threads;
create policy whatsapp_threads_tenant_all on public.whatsapp_threads
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists whatsapp_messages_tenant_all on public.whatsapp_messages;
create policy whatsapp_messages_tenant_all on public.whatsapp_messages
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists whatsapp_message_statuses_tenant_all on public.whatsapp_message_statuses;
create policy whatsapp_message_statuses_tenant_all on public.whatsapp_message_statuses
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

-- No authenticated read policy for whatsapp_webhook_events: raw payload may contain personal data.
-- Server-side webhook processing uses the Supabase service role.
