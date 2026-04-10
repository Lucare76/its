-- Migration 0111: stop_order su bus_ischia_dist_allocations
-- Ordine geografico fermate ad Ischia (nearest-neighbor dal porto)

alter table public.bus_ischia_dist_allocations
  add column if not exists stop_order integer not null default 0;

comment on column public.bus_ischia_dist_allocations.stop_order is
  'Ordine geografico di discesa degli ospiti (0 = primo, calcolato nearest-neighbor dal porto Ischia).';
