-- Do not treat punctuation-only placeholders as conversation names.
update public.whatsapp_contacts
set manual_contact_name = null
where manual_contact_name is not null
  and btrim(manual_contact_name) !~ '[[:alnum:]]';

update public.whatsapp_contacts
set customer_full_name = null
where customer_full_name is not null
  and btrim(customer_full_name) !~ '[[:alnum:]]';
