-- Aggiunge il campo nome gruppo/cliente ai bus unit (visibile quando tag = 'gruppi' o 'esclusivo')
alter table public.tenant_bus_units
  add column if not exists group_name text;
