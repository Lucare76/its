-- Persist WhatsApp reply context so inbound answers can be linked to the
-- outbound message/template they are answering.

do $$
begin
  if to_regclass('public.whatsapp_messages') is null then
    raise exception '0213_whatsapp_reply_context requires public.whatsapp_messages. Run 0175_whatsapp_cloud_inbox.sql first.';
  end if;
end $$;

alter table public.whatsapp_messages
  add column if not exists reply_to_wa_message_id text null,
  add column if not exists template_name text null,
  add column if not exists updated_at timestamptz not null default timezone('utc'::text, now());

create index if not exists idx_whatsapp_messages_tenant_reply_to
  on public.whatsapp_messages (tenant_id, reply_to_wa_message_id)
  where reply_to_wa_message_id is not null;

create index if not exists idx_whatsapp_messages_reply_to_null_tenant
  on public.whatsapp_messages (reply_to_wa_message_id)
  where tenant_id is null and reply_to_wa_message_id is not null;

create index if not exists idx_whatsapp_messages_tenant_template
  on public.whatsapp_messages (tenant_id, template_name)
  where template_name is not null;

create or replace function public.touch_whatsapp_messages_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_whatsapp_messages_updated_at on public.whatsapp_messages;
create trigger trg_whatsapp_messages_updated_at
before update on public.whatsapp_messages
for each row execute function public.touch_whatsapp_messages_updated_at();
