-- Migration 0110: tag opzionale su tenant_bus_units
-- gruppi   = gruppo organizzato (badge informativo)
-- esclusivo = bus riservato — chiude automaticamente, smistamento Ischia dedicato

alter table public.tenant_bus_units
  add column if not exists tag text null
    check (tag is null or tag in ('gruppi', 'esclusivo'));

comment on column public.tenant_bus_units.tag is
  'Tag opzionale: gruppi = gruppo organizzato, esclusivo = bus riservato (chiude automaticamente e smistamento Ischia dedicato).';
