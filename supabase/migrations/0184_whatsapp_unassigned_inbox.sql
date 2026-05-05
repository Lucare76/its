-- Allow WhatsApp inbound records to be stored even when tenant matching fails.

alter table public.whatsapp_contacts
  alter column tenant_id drop not null;

alter table public.whatsapp_threads
  alter column tenant_id drop not null;

alter table public.whatsapp_messages
  alter column tenant_id drop not null;

create index if not exists idx_whatsapp_contacts_null_tenant_wa
  on public.whatsapp_contacts (wa_id)
  where tenant_id is null;

create index if not exists idx_whatsapp_threads_null_tenant_wa
  on public.whatsapp_threads (wa_id)
  where tenant_id is null;

create index if not exists idx_whatsapp_messages_null_tenant_thread_created
  on public.whatsapp_messages (thread_id, created_at asc)
  where tenant_id is null;
