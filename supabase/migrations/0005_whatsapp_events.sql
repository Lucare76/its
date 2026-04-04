-- Migration: whatsapp delivery/read/failure event log
create table if not exists public.whatsapp_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid null references public.services (id) on delete set null,
  to_phone text not null,
  template text null,
  status text not null check (status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  provider_message_id text null,
  happened_at timestamptz not null default now(),
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_events_tenant_happened_at on public.whatsapp_events (tenant_id, happened_at desc);
create index if not exists idx_whatsapp_events_service_id on public.whatsapp_events (service_id);
create index if not exists idx_whatsapp_events_provider_message_id on public.whatsapp_events (provider_message_id);

alter table public.whatsapp_events enable row level security;

drop policy if exists whatsapp_events_tenant_all on public.whatsapp_events;
create policy whatsapp_events_tenant_all on public.whatsapp_events
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());
