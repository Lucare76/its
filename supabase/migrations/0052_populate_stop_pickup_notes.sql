-- Popola pickup_note per tutte le fermate da PDF "Ischia con Bus 2026"
-- Il match avviene sul stop_name (case-insensitive) per tutti i tenant

-- LINEA 1 ITALIA
update public.tenant_bus_line_stops set pickup_note = 'Via Borgosatollo (No Paese) Zona Volta / Distributore Eni' where stop_name ilike 'brescia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Parcheggio Hotel Dei Mille' where stop_name ilike 'bergamo' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Cascina Gobba Terminal Metro' where stop_name ilike 'milano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'melegnano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Parcheggio Benet' where stop_name ilike 'lodi' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Parcheggio Stabilimento Iveco' where stop_name ilike 'piacenza' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'fidenza' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Parcheggio Scambiatore' where stop_name ilike 'parma' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'reggio emilia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Nord' where stop_name ilike 'modena' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Area Di Servizio Cantagallo' where stop_name ilike 'bologna' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel The Gate' where stop_name ilike 'firenze' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'incisa' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'valdarno' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'arezzo' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'monte san savino' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'valdichiana' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'chiusi%' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Area Di Servizio' where stop_name ilike 'fabro' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Ristorante Food Village' where stop_name ilike 'orvieto' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel Tevere' where stop_name ilike 'orte' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Area Di Servizio Prenestina Ovest' where stop_name ilike 'roma' and (pickup_note is null or pickup_note = '');

-- LINEA 2 PIEMONTE
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'ivrea' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'A.p.t. Via Lamarmora' where stop_name ilike 'biella' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'cavaglia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'vercelli%' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'C.so Stati Uniti 17' where stop_name ilike 'torino' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'villanova' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Punto Blu' where stop_name ilike 'novara' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Est' where stop_name ilike 'asti' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Ovest' where stop_name ilike 'santhia%' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Ovest' where stop_name ilike 'alessandria' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'tortona' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'voghera' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'casteggio' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'castel san giovanni' and (pickup_note is null or pickup_note = '');

-- LINEA 3 LIGURIA
update public.tenant_bus_line_stops set pickup_note = 'Casello Ovest davanti Novotel' where stop_name ilike 'genova' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Rotonda Uscita Autostradale' where stop_name ilike 'chiavari' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Centro Commerciale La Fabbrica' where stop_name ilike 'la spezia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Uscita Autostradale' where stop_name ilike 'massa' and (pickup_note is null or pickup_note = '');

-- LINEA 4 LOMBARDIA
update public.tenant_bus_line_stops set pickup_note = 'Stazione Ff.ss.' where stop_name ilike 'varese' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'gallarate' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Uscita Aut. distributore Api' where stop_name ilike 'busto arsizio' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Uscita Autostradale' where stop_name ilike 'legnano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'lainate' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'rho' and (pickup_note is null or pickup_note = '');

-- LINEA 5 LOMBARDIA 2
update public.tenant_bus_line_stops set pickup_note = 'Piazza Stazione Fs' where stop_name ilike 'lecco' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Stazione Fs' where stop_name ilike 'erba' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Piazza Matteotti' where stop_name ilike 'como' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Stazione Fs' where stop_name ilike 'seregno' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Piazza Castello Pensilina Bus' where stop_name ilike 'monza' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Torri Ananas' where stop_name ilike 'sesto san giovanni' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'cremona' and (pickup_note is null or pickup_note = '');

-- LINEA 6 VENETO
update public.tenant_bus_line_stops set pickup_note = 'Foro Boario' where stop_name ilike 'feltre' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Stazione Ferroviaria' where stop_name ilike 'belluno' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Sud' where stop_name ilike 'vittorio veneto' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'conegliano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Sud' where stop_name ilike 'treviso' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Rotonda Holiday Inn' where stop_name ilike 'mestre' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Est' where stop_name ilike 'vicenza' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Sud' where stop_name ilike 'rovigo' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel Sheraton' where stop_name ilike 'padova' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Nord' where stop_name ilike 'ferrara' and (pickup_note is null or pickup_note = '');

-- LINEA 7 CENTRO
update public.tenant_bus_line_stops set pickup_note = 'Parcheggio Stadio' where stop_name ilike 'citt_ di castello' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Uscita Autostrada Zona industriale' where stop_name ilike 'umbertide' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Pian Di Massiano (St. Minimetrò)' where stop_name ilike 'perugia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Piazzale Mercedes' where stop_name ilike 'ponte san giovanni' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel Antonelli' where stop_name ilike 's. maria degli angeli' or stop_name ilike 'santa maria degli angeli' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'City Hotel' where stop_name ilike 'foligno' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel Arca' where stop_name ilike 'spoleto' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Piazzale Romiti' where stop_name ilike 'viterbo' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Agenzia Tiva Viaggi' where stop_name ilike 'amelia' and (pickup_note is null or pickup_note = '');

-- LINEA 8 CENTRO
update public.tenant_bus_line_stops set pickup_note = 'C/O Largo Mazzoni di fronte Negozio Smea' where stop_name ilike 'roma tiburtina' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Fermata Atac 502 Piazzale Mercato' where stop_name ilike 'roma anagnina' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello' where stop_name ilike 'valmontone' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello' where stop_name ilike 'cassino' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Nord' where stop_name ilike 'caserta' and (pickup_note is null or pickup_note = '');

-- LINEA 9 TRENTINO
update public.tenant_bus_line_stops set pickup_note = 'Stazione Fs' where stop_name ilike 'merano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'P.zza Matteotti' where stop_name ilike 'bolzano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'san michele all_adige' or stop_name ilike 'san michele all''adige' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Sud' where stop_name ilike 'trento' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Nord' where stop_name ilike 'rovereto' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'ala%avio' or stop_name ilike 'ala/avio' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'affi' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Stazione P. Nuova' where stop_name ilike 'verona' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Nord' where stop_name ilike 'mantova' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'carpi' and (pickup_note is null or pickup_note = '');

-- LINEA 10 TOSCANA
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'viareggio' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Stazione Ferroviaria' where stop_name ilike 'livorno' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'pisa' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel Napoleon' where stop_name ilike 'lucca' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Stazione Fs' where stop_name ilike 'montecatini' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Parch. difronte Superm. Breda' where stop_name ilike 'pistoia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Hotel Palace / Porta Fiorentina' where stop_name ilike 'prato' and (pickup_note is null or pickup_note = '');

-- LINEA 11 ADRIATICA
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'cesena' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Sud' where stop_name ilike 'rimini' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'cattolica' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'pesaro' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'fano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Rotatoria Centro Commerciale' where stop_name ilike 'senigallia' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Uscita Superstrada Iesi Centro' where stop_name ilike 'iesi' or stop_name ilike 'jesi' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale Nord' where stop_name ilike 'ancona' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'civitanova%' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where (stop_name ilike 'san benedetto%' or stop_name ilike 's. benedetto%') and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'giulianova' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'pescara%' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'sulmona' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Casello Autostradale' where stop_name ilike 'avezzano' and (pickup_note is null or pickup_note = '');
update public.tenant_bus_line_stops set pickup_note = 'Uscita Superstrada' where stop_name ilike 'sora' and (pickup_note is null or pickup_note = '');

-- Fermate con pickup_note descrittivo non deducibile dal nome città
update public.tenant_bus_line_stops set pickup_note = 'Terminal Bus Atc' where stop_name ilike 'terni' and (pickup_note is null or pickup_note = '');

-- Aggiornamenti forzati per alias noti che variano tra file diversi
update public.tenant_bus_line_stops set pickup_note = 'Hotel Palace / Porta Fiorentina'    where stop_name ilike 'prato';
update public.tenant_bus_line_stops set pickup_note = 'Stazione Fs'                         where stop_name ilike 'montecatini';
update public.tenant_bus_line_stops set pickup_note = 'Stazione Ferroviaria'                where stop_name ilike 'livorno';
update public.tenant_bus_line_stops set pickup_note = 'Stazione Ferroviaria'                where stop_name ilike 'belluno';
update public.tenant_bus_line_stops set pickup_note = 'Cascina Gobba / Terminal Metro'      where stop_name ilike 'milano';
update public.tenant_bus_line_stops set pickup_note = 'Parcheggio Hotel Dei Mille'          where stop_name ilike 'bergamo';
update public.tenant_bus_line_stops set pickup_note = 'Via Borgosatollo / Distributore Eni' where stop_name ilike 'brescia';
update public.tenant_bus_line_stops set pickup_note = 'Stazione FS'                         where stop_name ilike 'foligno';
update public.tenant_bus_line_stops set pickup_note = 'Metropolitana Cologno'               where stop_name ilike 'cologno%';
update public.tenant_bus_line_stops set pickup_note = 'Piazza Donatori Di Sangue'           where stop_name ilike 'bovezzo';
update public.tenant_bus_line_stops set pickup_note = 'Terminal Bus Atc'                    where stop_name ilike 'terni';
update public.tenant_bus_line_stops set pickup_note = 'Fermata Atac 502 Piazzale Mercato'   where stop_name ilike 'roma anagnina';
