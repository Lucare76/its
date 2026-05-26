create unique index if not exists whatsapp_contacts_tenant_phone_e164_unique
  on public.whatsapp_contacts (tenant_id, phone_e164)
  where tenant_id is not null and phone_e164 is not null;

