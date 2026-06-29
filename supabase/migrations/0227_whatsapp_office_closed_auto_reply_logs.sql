-- Log idempotente per auto-risposte WhatsApp fuori orario.

create table if not exists public.whatsapp_auto_reply_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone_number text not null,
  conversation_id uuid null references public.whatsapp_threads (id) on delete set null,
  auto_reply_type text not null,
  closure_window_key text not null,
  provider_message_id text null,
  send_status text not null default 'pending' check (send_status in ('pending', 'sent', 'failed')),
  error_message text null,
  sent_at timestamptz null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  unique (tenant_id, phone_number, auto_reply_type, closure_window_key)
);

create index if not exists idx_whatsapp_auto_reply_logs_tenant_created
  on public.whatsapp_auto_reply_logs (tenant_id, created_at desc);

create index if not exists idx_whatsapp_auto_reply_logs_tenant_phone_window
  on public.whatsapp_auto_reply_logs (tenant_id, phone_number, closure_window_key);

create or replace function public.touch_whatsapp_auto_reply_logs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_whatsapp_auto_reply_logs_updated_at on public.whatsapp_auto_reply_logs;
create trigger trg_whatsapp_auto_reply_logs_updated_at
before update on public.whatsapp_auto_reply_logs
for each row execute function public.touch_whatsapp_auto_reply_logs_updated_at();

alter table public.whatsapp_auto_reply_logs enable row level security;

drop policy if exists whatsapp_auto_reply_logs_tenant_all on public.whatsapp_auto_reply_logs;
create policy whatsapp_auto_reply_logs_tenant_all on public.whatsapp_auto_reply_logs
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());
