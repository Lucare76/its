-- Aggiunge dati aziendali al tenant (ragione sociale, indirizzo, P.IVA, contatti)
-- Usati nei PDF, email template e intestazioni documenti

alter table public.tenants
  add column if not exists legal_name     text null,        -- Ragione sociale completa
  add column if not exists address        text null,        -- Indirizzo sede legale
  add column if not exists vat_number     text null,        -- P.IVA
  add column if not exists contact_email  text null,        -- Email di contatto pubblica
  add column if not exists contact_phone  text null,        -- Telefono di contatto
  add column if not exists website_url    text null,        -- Sito web (opzionale)
  add column if not exists updated_at     timestamptz not null default now();
