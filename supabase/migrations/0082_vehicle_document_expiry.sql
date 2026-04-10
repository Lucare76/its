-- Scadenze documenti veicoli: assicurazione, bollo, collaudo

alter table public.vehicles
  add column if not exists insurance_expiry  date null,
  add column if not exists road_tax_expiry   date null,
  add column if not exists inspection_expiry date null;
