-- FIX FINALE bus_exclusive A/R — Obiettivo E: referente/telefono per singola
-- fermata gruppo. Additiva, nullable, nessun default inventato: il fallback
-- in lettura (telefono fermata -> contact_phone del gruppo -> "non indicato")
-- resta lato applicazione (lib/booking-groups.ts / UI), non nello schema.

alter table public.booking_group_stops
  add column if not exists contact_name text null;

alter table public.booking_group_stops
  add column if not exists contact_phone text null;

comment on column public.booking_group_stops.contact_name is
  'Referente della singola fermata (facoltativo). Fallback in lettura: contact_name del gruppo.';
comment on column public.booking_group_stops.contact_phone is
  'Telefono della singola fermata (facoltativo). Fallback in lettura: contact_phone del gruppo, poi "Telefono non indicato".';
