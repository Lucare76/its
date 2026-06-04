alter table public.whatsapp_contacts
  add column if not exists customer_full_name text,
  add column if not exists wa_profile_name text;

update public.whatsapp_contacts contact
set customer_full_name = service.customer_name
from public.whatsapp_threads thread
join public.services service
  on service.id = thread.booking_id
 and service.tenant_id = thread.tenant_id
where thread.contact_id = contact.id
  and contact.customer_full_name is null
  and nullif(btrim(service.customer_name), '') is not null;

create index if not exists idx_whatsapp_contacts_tenant_customer_full_name
  on public.whatsapp_contacts (tenant_id, customer_full_name)
  where customer_full_name is not null;
