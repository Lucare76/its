-- Migration: add reminder kind to whatsapp events (24h | 2h | manual | webhook)

alter table public.whatsapp_events
  add column if not exists kind text null;

update public.whatsapp_events
set kind = coalesce(kind, payload_json ->> 'phase', 'manual')
where kind is null;

create index if not exists idx_whatsapp_events_kind_happened_at on public.whatsapp_events (kind, happened_at desc);

