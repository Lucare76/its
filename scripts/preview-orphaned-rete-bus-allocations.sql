-- SOLA LETTURA — nessun DELETE in questo file.
-- Individua le allocazioni "fantasma" sulla Rete Bus continentale
-- (tenant_bus_allocations) rimaste orfane per servizi gia' cancellati,
-- causate dal bug corretto da supabase/migrations/0245_fix_cancel_service_
-- practice_rete_bus_allocations.sql (le cancellazioni fatte PRIMA di
-- applicare la 0245 non vengono sanate retroattivamente: la funzione
-- corretta agisce solo sulle cancellazioni future).
--
-- Esegui nel SQL Editor di Supabase. Solo dopo revisione/conferma esplicita
-- si puo' valutare un DELETE mirato — non incluso qui di proposito.

-- 1. Elenco dettagliato delle righe orfane.
select tba.*
from public.tenant_bus_allocations tba
join public.services s on s.id = tba.service_id
where s.status = 'cancelled';

-- 2. Conteggio aggregato per tenant / linea / data, per stimare l'impatto
--    prima di decidere se e come bonificare.
select
  tba.tenant_id,
  tbl.name as bus_line_name,
  tbl.family_code,
  s.date as service_date,
  count(*) as orphaned_allocations,
  sum(tba.pax_assigned) as orphaned_pax
from public.tenant_bus_allocations tba
join public.services s on s.id = tba.service_id
left join public.tenant_bus_lines tbl on tbl.id = tba.bus_line_id
where s.status = 'cancelled'
group by tba.tenant_id, tbl.name, tbl.family_code, s.date
order by s.date desc, orphaned_pax desc;
