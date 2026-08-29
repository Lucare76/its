-- ADDITIVE ONLY — do not run until reviewed and approved.
--
-- Estende ferry_pickup_rules per rappresentare le regole "dirette"
-- (SNAV diretto / MEDMAR diretto — oggi solo in lib/departure-pickup-rules.ts,
-- funzioni SNAV_DIRECT/MEDMAR_DIRECT). A differenza delle regole treno/volo
-- (direction='from_ischia', transport_type in ('train','flight')), le regole
-- dirette non hanno un mezzo di collegamento da agganciare: il cliente prende
-- direttamente la nave dal proprio hotel. Non esiste quindi una "finestra di
-- arrivo del mezzo" (transport_from/transport_to) da matchare — il match
-- avviene sull'orario esatto della nave (departure_time), esattamente come fa
-- oggi getPickupRule() in lib/departure-pickup-rules.ts confrontando t_from.
--
-- Questa migration NON sposta dati: si limita ad allargare lo schema perché
-- una migration di seed futura possa inserire anche le regole dirette senza
-- forzare transport_from/transport_to a valori inventati (es. uguali a
-- departure_time), che romperebbero isTransportWindowValid() e la logica di
-- conflitto a finestra oraria in lib/ferry-pickup-rules.ts.

-- 1. Amplia il check su transport_type per includere 'direct'.
--    Nome vincolo auto-generato da Postgres per un CHECK inline su colonna
--    (verificare con \d ferry_pickup_rules prima di eseguire, in caso il nome
--    reale differisca da quello atteso qui sotto).
alter table public.ferry_pickup_rules
  drop constraint if exists ferry_pickup_rules_transport_type_check;

alter table public.ferry_pickup_rules
  add constraint ferry_pickup_rules_transport_type_check
  check (transport_type in ('train', 'flight', 'direct'));

-- 2. transport_from/transport_to diventano nullable: per le regole dirette
--    non rappresentano nulla (nessun mezzo di collegamento da attendere).
alter table public.ferry_pickup_rules
  alter column transport_from drop not null;

alter table public.ferry_pickup_rules
  alter column transport_to drop not null;

-- 3. Coerenza: le regole dirette hanno SEMPRE transport_from/to null; tutte
--    le altre (train/flight) li richiedono SEMPRE entrambi (comportamento
--    legacy invariato, nessuna riga esistente è affetta perché sono tutte
--    train/flight con entrambi i campi valorizzati).
alter table public.ferry_pickup_rules
  add constraint ferry_pickup_rules_direct_window_check
  check (
    (transport_type = 'direct' and transport_from is null and transport_to is null)
    or
    (transport_type <> 'direct' and transport_from is not null and transport_to is not null)
  );

-- Rollback (commentato, non eseguire automaticamente):
-- alter table public.ferry_pickup_rules drop constraint if exists ferry_pickup_rules_direct_window_check;
-- alter table public.ferry_pickup_rules alter column transport_from set not null;
-- alter table public.ferry_pickup_rules alter column transport_to set not null;
-- alter table public.ferry_pickup_rules drop constraint if exists ferry_pickup_rules_transport_type_check;
-- alter table public.ferry_pickup_rules add constraint ferry_pickup_rules_transport_type_check check (transport_type in ('train','flight'));
