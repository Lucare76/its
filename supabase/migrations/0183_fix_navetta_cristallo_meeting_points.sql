-- Migration 0169: Correzione meeting point navetta Hotel Cristallo
-- Regola richiesta:
--   departure -> meeting_point = Htl Cristallo
--   arrival   -> meeting_point = Piazza Marina Casamicciola

do $$
declare
  v_tenant uuid := 'd200b89a-64c7-4f8d-a430-95a33b83047a';
  v_hotel uuid;
begin
  select id into v_hotel
  from public.hotels
  where tenant_id = v_tenant
    and name ilike '%cristallo%'
  order by name
  limit 1;

  if v_hotel is null then
    raise exception '[0169] Hotel Cristallo non trovato – migrazione interrotta.';
  end if;

  update public.services
  set meeting_point = 'Htl Cristallo'
  where tenant_id = v_tenant
    and hotel_id = v_hotel
    and booking_service_kind = 'navetta'
    and direction = 'departure'
    and date between '2026-04-29' and '2026-12-08';

  update public.services
  set meeting_point = 'Piazza Marina Casamicciola'
  where tenant_id = v_tenant
    and hotel_id = v_hotel
    and booking_service_kind = 'navetta'
    and direction = 'arrival'
    and date between '2026-04-29' and '2026-12-08';

  raise notice '[0169] Meeting point navetta Cristallo corretti.';
end $$;
