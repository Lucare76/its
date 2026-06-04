alter table public.whatsapp_contacts
  add column if not exists customer_full_name text,
  add column if not exists wa_profile_name text,
  add column if not exists manual_contact_name text;

-- Manual conversations can be opened from the inbox with only a phone number
-- and an operator-provided contact name. Those numbers may have no service
-- linked, so preserve that internal name separately from the WhatsApp profile.
update public.whatsapp_contacts contact
set
  manual_contact_name = btrim(contact.profile_name),
  customer_full_name = coalesce(nullif(btrim(contact.customer_full_name), ''), btrim(contact.profile_name))
where nullif(btrim(contact.profile_name), '') is not null
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

-- Recover names for old conversations where contact_id was missing or stale.
with linked_thread_names as (
  select distinct on (contact.id)
    contact.id as contact_id,
    coalesce(
      nullif(btrim(concat_ws(' ', service.customer_first_name, service.customer_last_name)), ''),
      nullif(btrim(service.customer_name), '')
    ) as internal_name
  from public.whatsapp_contacts contact
  join public.whatsapp_threads thread
    on (
      thread.contact_id = contact.id
      or (
        thread.tenant_id = contact.tenant_id
        and thread.wa_id = contact.wa_id
      )
    )
  join public.services service
    on service.id = thread.booking_id
   and service.tenant_id = thread.tenant_id
  where nullif(btrim(coalesce(
          nullif(btrim(concat_ws(' ', service.customer_first_name, service.customer_last_name)), ''),
          service.customer_name
        )), '') is not null
  order by contact.id, service.date desc nulls last, service.created_at desc nulls last
)
update public.whatsapp_contacts contact
set customer_full_name = linked.internal_name
from linked_thread_names linked
where linked.contact_id = contact.id
  and (
    contact.customer_full_name is null
    or btrim(contact.customer_full_name) = ''
    or contact.customer_full_name = contact.wa_profile_name
    or (linked.internal_name like '% %' and contact.customer_full_name not like '% %')
  );

-- Recover names by phone suffix, covering +39/0039/no-prefix historical variants.
with contact_digits as (
  select
    id,
    tenant_id,
    regexp_replace(coalesce(phone_e164, wa_id, ''), '[^0-9]', '', 'g') as digits
  from public.whatsapp_contacts
),
service_digits as (
  select
    id,
    tenant_id,
    date,
    created_at,
    regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') as digits,
    coalesce(
      nullif(btrim(concat_ws(' ', customer_first_name, customer_last_name)), ''),
      nullif(btrim(customer_name), '')
    ) as internal_name
  from public.services
  where nullif(btrim(coalesce(
          nullif(btrim(concat_ws(' ', customer_first_name, customer_last_name)), ''),
          customer_name
        )), '') is not null
),
phone_matches as (
  select distinct on (contact.id)
    contact.id as contact_id,
    service.internal_name
  from contact_digits contact
  join service_digits service
    on service.tenant_id = contact.tenant_id
   and length(contact.digits) >= 8
   and length(service.digits) >= 8
   and (
     contact.digits = service.digits
     or right(contact.digits, 10) = right(service.digits, 10)
     or right(contact.digits, 9) = right(service.digits, 9)
   )
  order by contact.id, service.date desc nulls last, service.created_at desc nulls last
)
update public.whatsapp_contacts contact
set customer_full_name = phone_matches.internal_name
from phone_matches
where phone_matches.contact_id = contact.id
  and (
    contact.customer_full_name is null
    or btrim(contact.customer_full_name) = ''
    or contact.customer_full_name = contact.wa_profile_name
    or (phone_matches.internal_name like '% %' and contact.customer_full_name not like '% %')
  );
