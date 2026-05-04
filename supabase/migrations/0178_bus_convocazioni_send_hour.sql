-- Ora di invio configurabile per le convocazioni bus_city_hotel (default 13:00)
alter table public.tenant_whatsapp_settings
  add column if not exists bus_convocazioni_send_hour integer not null default 13
    check (bus_convocazioni_send_hour between 0 and 23);
