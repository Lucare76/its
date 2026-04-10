-- Migration 0109: bus_line_id nullable su bus_ischia_dist_buses
-- Lo smistamento ad Ischia è per data (tutti i bus), non per singola linea.

alter table public.bus_ischia_dist_buses
  alter column bus_line_id drop not null;
