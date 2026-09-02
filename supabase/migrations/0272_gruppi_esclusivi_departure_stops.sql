-- FIX MIRATO GIACOMONI — Obiettivo A: la linea "Bus esclusivi gruppi"
-- (tenant_bus_lines.code = 'GRUPPI_ESCLUSIVI') aveva UN SOLO stop di
-- catalogo per la direzione 'departure' (MAROTTA). Qualunque fermata di
-- ritorno diversa da MAROTTA non poteva mai essere risolta da
-- resolveCanonicalBookingGroupStop (lib/server/booking-groups-service.ts) —
-- comportamento corretto (mai un'assegnazione indovinata), ma bloccava
-- l'allocazione di FANO/PESARO/CATTOLICA al ritorno.
--
-- Additiva e idempotente (insert ... where not exists): non tocca righe
-- esistenti, non duplica se rieseguita. pickup_note allineato ai dati reali
-- già presenti su booking_group_stops/services per queste città (CASELLO
-- A14 per PESARO/CATTOLICA, PARCHEGGIO CASELLO A14 per FANO — stessa
-- convenzione già usata per le fermate arrival della stessa linea).
--
-- pickup_time lasciato NULL: nessun orario reale di ritorno è noto per
-- queste tre fermate — mai un 00:00 o un orario copiato da un'altra
-- fermata spacciato per reale. Da completare manualmente (operatore) via
-- "Collega/orario catalogo" in /booking-groups quando l'orario è confermato.
--
-- sort_order: ordine ritorno atteso Sud->Nord (inverso dell'andata
-- Nord->Sud): MAROTTA(1, già presente) -> FANO(2) -> PESARO(3) -> CATTOLICA(4).

do $$
declare
  v_line record;
begin
  for v_line in
    select id as line_id, tenant_id
    from public.tenant_bus_lines
    where code = 'GRUPPI_ESCLUSIVI' or family_code = 'GRUPPI_ESCLUSIVI'
  loop
    insert into public.tenant_bus_line_stops (
      tenant_id, bus_line_id, direction, city, stop_name, pickup_note,
      pickup_time, stop_order, order_index, is_manual, active
    )
    select v_line.tenant_id, v_line.line_id, 'departure', 'FANO', 'FANO', 'PARCHEGGIO CASELLO A14',
           null, 2, 2, true, true
    where not exists (
      select 1 from public.tenant_bus_line_stops
      where tenant_id = v_line.tenant_id
        and bus_line_id = v_line.line_id
        and direction = 'departure'
        and upper(trim(city)) = 'FANO'
    );

    insert into public.tenant_bus_line_stops (
      tenant_id, bus_line_id, direction, city, stop_name, pickup_note,
      pickup_time, stop_order, order_index, is_manual, active
    )
    select v_line.tenant_id, v_line.line_id, 'departure', 'PESARO', 'PESARO', 'CASELLO A14',
           null, 3, 3, true, true
    where not exists (
      select 1 from public.tenant_bus_line_stops
      where tenant_id = v_line.tenant_id
        and bus_line_id = v_line.line_id
        and direction = 'departure'
        and upper(trim(city)) = 'PESARO'
    );

    insert into public.tenant_bus_line_stops (
      tenant_id, bus_line_id, direction, city, stop_name, pickup_note,
      pickup_time, stop_order, order_index, is_manual, active
    )
    select v_line.tenant_id, v_line.line_id, 'departure', 'CATTOLICA', 'CATTOLICA', 'CASELLO A14',
           null, 4, 4, true, true
    where not exists (
      select 1 from public.tenant_bus_line_stops
      where tenant_id = v_line.tenant_id
        and bus_line_id = v_line.line_id
        and direction = 'departure'
        and upper(trim(city)) = 'CATTOLICA'
    );
  end loop;
end $$;
