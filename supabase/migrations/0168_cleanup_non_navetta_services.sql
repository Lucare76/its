-- Migration 0168: Rimozione servizi non-navetta
-- Mantiene solo i servizi con booking_service_kind = 'navetta'
-- o vessel = 'Navetta' (navette pre-migrazione 0163).
-- Tutti gli altri transfer/escursioni/bus vengono eliminati.

delete from public.services
where tenant_id = 'd200b89a-64c7-4f8d-a430-95a33b83047a'
  and not (
    booking_service_kind = 'navetta'
    or lower(trim(coalesce(vessel, ''))) = 'navetta'
  );
