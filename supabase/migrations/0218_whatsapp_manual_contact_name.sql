alter table public.whatsapp_contacts
  add column if not exists manual_contact_name text,
  add column if not exists wa_profile_name text;

-- Preserve the operator-entered conversation label for manual WhatsApp chats.
-- These chats may have no service, so the label must not be derived from
-- inbound WhatsApp profile data.
update public.whatsapp_contacts contact
set
  manual_contact_name = btrim(contact.profile_name),
  customer_full_name = coalesce(nullif(btrim(contact.customer_full_name), ''), btrim(contact.profile_name))
where nullif(btrim(contact.profile_name), '') is not null
  and btrim(contact.profile_name) ~ '[[:alnum:]]'
  and btrim(contact.profile_name) !~ '^[+0-9 ()-]+$'
  and (
    contact.wa_profile_name is null
    or btrim(contact.profile_name) is distinct from btrim(contact.wa_profile_name)
  )
  and not exists (
    select 1
    from public.whatsapp_threads thread
    where (
        thread.contact_id = contact.id
        or (
          thread.tenant_id = contact.tenant_id
          and thread.wa_id = contact.wa_id
        )
      )
      and (thread.booking_id is not null or thread.transfer_id is not null)
  )
  and (
    contact.manual_contact_name is null
    or btrim(contact.manual_contact_name) = ''
    or (
      contact.wa_profile_name is not null
      and btrim(contact.manual_contact_name) = btrim(contact.wa_profile_name)
    )
  );

create index if not exists idx_whatsapp_contacts_tenant_manual_contact_name
  on public.whatsapp_contacts (tenant_id, manual_contact_name)
  where manual_contact_name is not null;
