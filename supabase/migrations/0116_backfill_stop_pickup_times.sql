-- Migration 0116: backfill pickup_time sulle fermate esistenti dal catalogo 2026
-- Prima era salvato solo pickup_note, non l'orario di partenza.

update public.tenant_bus_line_stops set pickup_time = '05:00' where city ilike 'brescia'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:45' where city ilike 'bergamo'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:30' where city ilike 'milano'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:45' where city ilike 'melegnano'     and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:00' where city ilike 'lodi'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:30' where city ilike 'piacenza'      and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:50' where city ilike 'fidenza'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:00' where city ilike 'parma'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:30' where city ilike 'reggio emilia' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:45' where city ilike 'modena'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '09:15' where city ilike 'bologna'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '10:40' where city ilike 'firenze'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:00' where city ilike 'incisa'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:15' where city ilike 'valdarno'      and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:40' where city ilike 'arezzo'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:55' where city ilike 'monte san savino' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '12:10' where city ilike 'valdichiana'   and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '12:30' where city ilike 'chiusi chianciano' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '12:45' where city ilike 'fabro'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '13:00' where city ilike 'orvieto'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '13:30' where city ilike 'orte'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '14:30' where city ilike 'roma'          and pickup_time is null;

-- Linea 2 Piemonte
update public.tenant_bus_line_stops set pickup_time = '04:15' where city ilike 'ivrea'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:40' where city ilike 'biella'             and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:55' where city ilike 'cavaglia'           and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:00' where city ilike 'vercelli%'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:15' where city ilike 'torino'             and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:25' where city ilike 'villanova'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:40' where city ilike 'novara'             and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:45' where city ilike 'asti'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:55' where city ilike 'santhia%'           and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:00' where city ilike 'alessandria'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:10' where city ilike 'tortona'            and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:20' where city ilike 'voghera'            and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:30' where city ilike 'casteggio'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:45' where city ilike 'castel san giovanni' and pickup_time is null;

-- Linea 3 Liguria
update public.tenant_bus_line_stops set pickup_time = '06:20' where city ilike 'genova'    and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:40' where city ilike 'chiavari'  and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:20' where city ilike 'la spezia' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:30' where city ilike 'massa'     and pickup_time is null;

-- Linea 4 Lombardia
update public.tenant_bus_line_stops set pickup_time = '05:00' where city ilike 'varese'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:20' where city ilike 'gallarate'     and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:30' where city ilike 'busto arsizio' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:40' where city ilike 'legnano'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:50' where city ilike 'lainate'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:05' where city ilike 'rho'           and pickup_time is null;

-- Linea 5 Lombardia 2
update public.tenant_bus_line_stops set pickup_time = '04:20' where city ilike 'lecco'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:45' where city ilike 'erba'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:10' where city ilike 'como'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:30' where city ilike 'seregno'            and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:50' where city ilike 'monza'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:00' where city ilike 'sesto san giovanni' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:00' where city ilike 'cremona'            and pickup_time is null;

-- Linea 6 Veneto
update public.tenant_bus_line_stops set pickup_time = '03:30' where city ilike 'feltre'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:00' where city ilike 'belluno'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:35' where city ilike 'vittorio veneto' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:00' where city ilike 'conegliano'      and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:20' where city ilike 'treviso'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:55' where city ilike 'mestre'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:20' where city ilike 'vicenza'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:30' where city ilike 'rovigo'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:30' where city ilike 'padova'          and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:00' where city ilike 'ferrara'         and pickup_time is null;

-- Linea 7 Centro
update public.tenant_bus_line_stops set pickup_time = '04:00' where city ilike 'citta%castello'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:15' where city ilike 'umbertide'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:30' where city ilike 'perugia'                and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '04:40' where city ilike 'ponte san giovanni'     and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:00' where city ilike '%maria%angeli%'         and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:15' where city ilike 'foligno'                and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:45' where city ilike 'spoleto'                and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:00' where city ilike 'viterbo'                and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:10' where city ilike 'amelia'                 and pickup_time is null;

-- Linea 8 Centro 2
update public.tenant_bus_line_stops set pickup_time = '07:45' where city ilike 'roma tiburtina' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:15' where city ilike 'roma anagnina'  and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:45' where city ilike 'valmontone'     and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '10:30' where city ilike 'cassino'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:10' where city ilike 'caserta'        and pickup_time is null;

-- Linea 9 Trentino
update public.tenant_bus_line_stops set pickup_time = '04:25' where city ilike 'merano'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:00' where city ilike 'bolzano'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:20' where city ilike '%adige%'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:35' where city ilike 'trento'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:05' where city ilike 'rovereto'             and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:20' where city ilike 'ala%avio'             and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:35' where city ilike 'affi'                 and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:45' where city ilike 'verona'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:30' where city ilike 'mantova'              and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:00' where city ilike 'carpi'                and pickup_time is null;

-- Linea 10 Toscana
update public.tenant_bus_line_stops set pickup_time = '08:00' where city ilike 'viareggio'   and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:15' where city ilike 'livorno'     and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:35' where city ilike 'pisa'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:55' where city ilike 'lucca'       and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '09:15' where city ilike 'montecatini' and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '09:30' where city ilike 'pistoia'     and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '09:50' where city ilike 'prato'       and pickup_time is null;

-- Linea 11 Adriatica
update public.tenant_bus_line_stops set pickup_time = '04:45' where city ilike 'cesena'                    and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:10' where city ilike 'rimini'                    and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:25' where city ilike 'cattolica'                 and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:40' where city ilike 'pesaro'                    and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '05:50' where city ilike 'fano'                      and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:20' where city ilike 'senigallia'                and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:35' where city ilike 'iesi'                      and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '06:50' where city ilike 'ancona'                    and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '07:20' where city ilike 'civitanova%'               and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:10' where city ilike '%benedetto%tronto%'        and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '08:30' where city ilike 'giulianova'                and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '09:00' where city ilike 'pescara%'                  and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '09:30' where city ilike 'sulmona'                   and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '10:00' where city ilike 'avezzano'                  and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:00' where city ilike 'sora'                      and pickup_time is null;
update public.tenant_bus_line_stops set pickup_time = '11:30' where city ilike 'cassino'                   and pickup_time is null;
