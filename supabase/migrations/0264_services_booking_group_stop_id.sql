-- ============================================================
-- FASE 2 — Legame stabile SERVICE ↔ FERMATA GRUPPO.
--
-- Senza questa FK non è possibile distinguere in modo affidabile quale
-- booking_group_stop ha generato un service (city/meeting_point sono testo
-- libero e non univoci). Concetto diverso da booking_group_id (il contenitore
-- commerciale, migration 0263) e da linked_service_id / assignments.group_id.
--
-- NON tocca trip_groups / tenant_bus_allocations / tenant_bus_units /
-- bus_line_ferry_config.
-- ============================================================

alter table public.services
  add column if not exists booking_group_stop_id uuid null
    references public.booking_group_stops(id) on delete set null;

-- Indice tenant-aware, parziale (solo i service realmente collegati a un gruppo).
create index if not exists idx_services_tenant_booking_group_stop
  on public.services (tenant_id, booking_group_stop_id)
  where booking_group_stop_id is not null;

comment on column public.services.booking_group_stop_id is
  'FASE 2 gruppi prenotazione: FK nullable verso booking_group_stops. Traccia da quale fermata pianificata è nato il service. ON DELETE SET NULL.';
