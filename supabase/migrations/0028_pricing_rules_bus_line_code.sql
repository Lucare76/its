-- Migration: codice linea bus esplicito sulle regole prezzo

alter table public.pricing_rules
  add column if not exists bus_line_code text null;

create index if not exists idx_pricing_rules_bus_line_code
  on public.pricing_rules (tenant_id, bus_line_code);
