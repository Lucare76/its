-- Rende hotel_id nullable nella tabella services.
-- I servizi di linea bus (booking_service_kind = 'bus_city_hotel') non hanno hotel di riferimento.
-- Il vincolo NOT NULL impediva l'insert durante l'import Excel bus → tutti i passeggeri
-- finivano in bus_import_pending invece di essere allocati.
-- La view ops_bus_allocation_details usa già LEFT JOIN su hotels, quindi hotel_id = null è gestito.

alter table public.services
  alter column hotel_id drop not null;
