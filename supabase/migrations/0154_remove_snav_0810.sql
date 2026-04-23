-- Rimuove la corsa SNAV aliscafo 08:10 Napoli Beverello → Casamicciola (non più in servizio).
-- Orari SNAV arrivi Casamicciola aggiornati:
--   08:30 / 09:20 / 11:30 / 12:30 / 13:55 / 15:10 / 16:20 / 17:10 / 19:00
--
-- Prima di eliminare: sposta i servizi esistenti con vessel che riferisce le 08:10
-- all'orario più vicino disponibile (08:30).

do $$
declare
  moved_count integer;
begin
  -- Sposta servizi con vessel = 'SNAV 08:10' (formato campo vessel arrivi)
  update public.services
  set
    vessel = replace(vessel, '08:10', '08:30'),
    time   = case when time = '08:10:00' then '08:30:00' else time end,
    notes  = coalesce(nullif(notes, ''), '') ||
             case when notes = '' or notes is null then '' else ' | ' end ||
             '[Corsa SNAV 08:10 soppressa — spostato a 08:30]'
  where
    vessel ilike '%snav%08:10%'
    and direction = 'arrival';

  get diagnostics moved_count = row_count;

  if moved_count > 0 then
    raise notice 'SNAV 08:10 → 08:30: spostati % servizi', moved_count;
  end if;
end $$;

-- Elimina la corsa dalla tabella degli orari
delete from public.ferry_schedules
where company = 'snav'
  and departure_port = 'napoli_beverello'
  and arrival_port   = 'casamicciola'
  and departure_time = '08:10:00';
