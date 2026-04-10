-- Migration 0114: corregge il typo "Benet" → "Bennet" per la fermata di Lodi

update public.tenant_bus_line_stops
set pickup_note = 'Parcheggio Bennet'
where stop_name ilike 'lodi'
  and pickup_note ilike '%Benet%';
