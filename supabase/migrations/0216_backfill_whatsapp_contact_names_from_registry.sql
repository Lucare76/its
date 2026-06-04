alter table public.whatsapp_contacts
  add column if not exists customer_full_name text,
  add column if not exists wa_profile_name text;

-- Prefer the structured service name when a historical thread is already linked.
with linked_service_names as (
  select distinct on (contact.id)
    contact.id as contact_id,
    coalesce(
      nullif(btrim(concat_ws(' ', service.customer_first_name, service.customer_last_name)), ''),
      nullif(btrim(service.customer_name), '')
    ) as internal_name
  from public.whatsapp_contacts contact
  join public.whatsapp_threads thread
    on thread.contact_id = contact.id
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
from linked_service_names linked
where linked.contact_id = contact.id
  and (
    contact.customer_full_name is null
    or btrim(contact.customer_full_name) = ''
    or contact.customer_full_name = contact.wa_profile_name
    or (linked.internal_name like '% %' and contact.customer_full_name not like '% %')
  );

-- Recover unlinked historical threads from services that have the same normalized phone.
with service_names_by_phone as (
  select distinct on (contact.id)
    contact.id as contact_id,
    coalesce(
      nullif(btrim(concat_ws(' ', service.customer_first_name, service.customer_last_name)), ''),
      nullif(btrim(service.customer_name), '')
    ) as internal_name
  from public.whatsapp_contacts contact
  join public.services service
    on service.tenant_id = contact.tenant_id
   and regexp_replace(coalesce(service.phone, ''), '[^0-9]', '', 'g')
       = regexp_replace(coalesce(contact.phone_e164, contact.wa_id, ''), '[^0-9]', '', 'g')
  where length(regexp_replace(coalesce(contact.phone_e164, contact.wa_id, ''), '[^0-9]', '', 'g')) >= 7
    and nullif(btrim(coalesce(
          nullif(btrim(concat_ws(' ', service.customer_first_name, service.customer_last_name)), ''),
          service.customer_name
        )), '') is not null
  order by contact.id, service.date desc nulls last, service.created_at desc nulls last
)
update public.whatsapp_contacts contact
set customer_full_name = phone_match.internal_name
from service_names_by_phone phone_match
where phone_match.contact_id = contact.id
  and (
    contact.customer_full_name is null
    or btrim(contact.customer_full_name) = ''
    or contact.customer_full_name = contact.wa_profile_name
    or (phone_match.internal_name like '% %' and contact.customer_full_name not like '% %')
  );

-- Last fallback: promote the old saved contact name only when it looks like
-- an internal registry name, not a WhatsApp profile/push name with emoji.
update public.whatsapp_contacts contact
set customer_full_name = btrim(contact.profile_name)
where (contact.customer_full_name is null or btrim(contact.customer_full_name) = '')
  and nullif(btrim(contact.profile_name), '') is not null
  and btrim(contact.profile_name) ~ '^[[:alpha:] ''.-]{2,120}$'
  and btrim(contact.profile_name) !~ '^[+0-9 ()-]+$';
