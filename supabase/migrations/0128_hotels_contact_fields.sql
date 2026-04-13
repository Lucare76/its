-- Aggiunge campi di contatto agli hotel: email e telefono
-- Usati per le comunicazioni di partenza (invio automatico ai ricettivi)
alter table public.hotels
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists contact_name text;

comment on column public.hotels.email        is 'Email del ricettivo per comunicazioni di partenza';
comment on column public.hotels.phone        is 'Telefono/WhatsApp del ricettivo';
comment on column public.hotels.contact_name is 'Nome referente del ricettivo (es. Ricevimento)';
