-- ADDITIVE ONLY — do not run until reviewed and approved.
--
-- Seed idempotente delle regole di PARTENZA (direction='from_ischia') per le
-- 6 categorie ancora solo statiche in lib/departure-pickup-rules.ts (SNAV
-- diretto, MEDMAR diretto, treno/volo + traghetto/aliscafo). MEDMAR Napoli e
-- MEDMAR Pozzuoli condividono transport_type='direct' + company='medmar':
-- si distinguono solo per arrival_port (napoli_beverello vs pozzuoli), non
-- servono due transport_type separati (vedi lib/departure-pickup-rules.ts
-- dove sono già unificati sotto lo stesso "medmar").
--
-- Richiede la migration 0261_ferry_pickup_rules_direct_type.sql già applicata
-- (transport_type='direct' + transport_from/to nullable).
--
-- CONFRONTO CON IL DB REALE (verificato in sola lettura sul progetto
-- ischia-transfer, 2026-08-30): la tabella ferry_pickup_rules ha oggi 60
-- righe, TUTTE con direction='to_ischia' (ARRIVI). Zero righe from_ischia.
-- Quindi delle 207 regole statiche in lib/departure-pickup-rules.ts:
--   identiche nel DB:  0
--   differenti nel DB: 0
--   mancanti nel DB:   207 (tutte)
-- Nessun conflitto da risolvere, nessuna riga da NON sovrascrivere: si tratta
-- di un inserimento a tabella vuota per questo dominio (from_ischia).
--
-- MAPPING APPLICATO (vedi anche scripts/readonly-generate-departure-rules-seed-20260830.ts,
-- che genera l'SQL qui sotto a partire da ALL_PICKUP_RULES — non modificare
-- questo blocco a mano, rigenerarlo con lo script se la sorgente cambia):
--
--  - transport_type: treno_* -> 'train', volo_* -> 'flight', snav/medmar -> 'direct'
--  - boat_type: *_traghetto/medmar -> 'traghetto', *_aliscafo/snav -> 'aliscafo'
--  - embark_port (Ischia, lato imbarco) = "porto_a" della regola statica
--  - arrival_port (continente)         = "porto_p" della regola statica
--    ATTENZIONE — DECISIONE CHE RICHIEDE CONFERMA MANUALE: nel file statico
--    porto_p/porto_a descrivono il verso COMMERCIALE della corsa (come
--    pubblicato dalla compagnia, es. "MEDMAR 06:20 Pozzuoli-Casamicciola"),
--    non il verso del cliente in partenza da Ischia. Per questo la mappatura
--    verso i campi embark_port/arrival_port del nuovo schema è invertita
--    rispetto ai nomi originali dei campi statici. Verificare con Mario
--    prima di applicare — se sbagliata, ogni orario nave/porto delle
--    partenze migrate sarebbe scambiato.
--  - not_sosandra:true  -> 1 riga agency_logic='aleste'
--    assente            -> 2 righe (agency_logic='aleste' E 'sosandra')
--  - exc (testo libero, solo 3 costanti nel file sorgente):
--    "Dal 1 giugno al 28 settembre: venerdì, sabato, domenica"
--      -> valid_from=2026-06-01, valid_to=2026-09-28, days_of_week={0,5,6}
--    "Dal 6 giugno al 13 settembre: venerdì, sabato, domenica, lunedì"
--      -> valid_from=2026-06-06, valid_to=2026-09-13, days_of_week={0,1,5,6}
--    "Dal 2 maggio al 30 maggio: ven e dom · Dal 1 giugno al 30 settembre:
--     tutti i giorni" (SNAV 15:15, un solo campo exc per DUE periodi diversi)
--      -> ESPANSA in due righe: 2026-05-02..2026-05-30 gg={0,5}, e
--         2026-06-01..2026-09-30 senza restrizione di giorni.
--    Le date di anno (2026/2027) sono state allineate alle stagionalità già
--    presenti nel DB per le regole ARRIVI (es. 2026-05-01..2026-09-15 =
--    "estate" nella migration 0187) — verificare che l'anno sia ancora
--    corretto al momento di applicare questa migration.
--
-- IDEMPOTENZA: l'intero seed è racchiuso in un blocco che si esegue SOLO se
-- non esiste già nessuna riga direction='from_ischia' nella tabella — quindi
-- rieseguire questa migration su un DB dove il seed è già stato applicato
-- (anche parzialmente a mano) non duplica nulla. Se in futuro qualcuno
-- inserisce manualmente anche una sola riga from_ischia prima di questa
-- migration, il seed automatico NON scatta più: bisognerà popolare a mano o
-- pulire e rieseguire consapevolmente (nessuna sovrascrittura silenziosa).

do $$
begin
  if not exists (select 1 from public.ferry_pickup_rules where direction = 'from_ischia') then

-- treno_traghetto: 25 regole statiche -> 45 righe DB
insert into public.ferry_pickup_rules
  (agency_logic, direction, transport_type, boat_type, hotel_id, zone,
   transport_from, transport_to, company, departure_time, embark_port, arrival_port, arrival_time,
   pickup_time, valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'ischia', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'ischia', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'lacco', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'lacco', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'barano', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'barano', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:00', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'forio', '09:00', '10:55', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'ischia', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:20', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'ischia', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:20', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'lacco', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'lacco', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'barano', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'barano', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'forio', '11:00', '13:15', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'ischia', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'ischia', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'lacco', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'lacco', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'barano', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'barano', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'forio', '13:20', '16:30', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'ischia', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'ischia', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'lacco', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'lacco', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:40', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'barano', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'barano', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'forio', '16:35', '18:40', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'ischia', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'ischia', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'lacco', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'lacco', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'casamicciola', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'barano', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '13:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'traghetto', null, 'barano', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '13:45', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'traghetto', null, 'forio', '18:45', '23:30', 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '13:45', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno');

-- treno_aliscafo: 34 regole statiche -> 62 righe DB
insert into public.ferry_pickup_rules
  (agency_logic, direction, transport_type, boat_type, hotel_id, zone,
   transport_from, transport_to, company, departure_time, embark_port, arrival_port, arrival_time,
   pickup_time, valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:45', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '08:30', '09:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'forio', '09:30', '10:40', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'forio', '11:45', '13:40', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '11:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '11:00', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'forio', '13:45', '16:10', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'forio', '16:15', '18:10', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:00', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'forio', '18:15', '19:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'ischia', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:40', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:40', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'lacco', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:40', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'casamicciola', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:40', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'barano', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'train', 'aliscafo', null, 'barano', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:15', null, null, null, null),
  ('aleste', 'from_ischia', 'train', 'aliscafo', null, 'forio', '20:00', '23:55', 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno');

-- volo_traghetto: 20 regole statiche -> 20 righe DB
insert into public.ferry_pickup_rules
  (agency_logic, direction, transport_type, boat_type, hotel_id, zone,
   transport_from, transport_to, company, departure_time, embark_port, arrival_port, arrival_time,
   pickup_time, valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'ischia', '10:00', '12:30', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'lacco', '10:00', '12:30', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'casamicciola', '10:00', '12:30', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'barano', '10:00', '12:30', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'forio', '10:00', '12:30', 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'ischia', '12:40', '14:30', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:20', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'lacco', '12:40', '14:30', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'casamicciola', '12:40', '14:30', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'barano', '12:40', '14:30', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'forio', '12:40', '14:30', 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'ischia', '14:45', '17:55', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'lacco', '14:45', '17:55', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'casamicciola', '14:45', '17:55', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'barano', '14:45', '17:55', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'forio', '14:45', '17:55', 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'ischia', '18:00', '23:55', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'lacco', '18:00', '23:55', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'casamicciola', '18:00', '23:55', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:40', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'barano', '18:00', '23:55', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'traghetto', null, 'forio', '18:00', '23:55', 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno');

-- volo_aliscafo: 28 regole statiche -> 56 righe DB
insert into public.ferry_pickup_rules
  (agency_logic, direction, transport_type, boat_type, hotel_id, zone,
   transport_from, transport_to, company, departure_time, embark_port, arrival_port, arrival_time,
   pickup_time, valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:45', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '09:35', '11:25', 'alilauro', '06:30', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '11:30', '12:55', 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '08:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '08:00', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '07:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '07:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '07:50', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '07:50', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '07:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '13:00', '13:55', 'alilauro', '08:40', 'ischia_porto', 'napoli_beverello', null, '07:45', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '14:00', '14:55', 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '11:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '11:00', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:45', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '15:00', '16:55', 'alilauro', '11:45', 'ischia_porto', 'napoli_beverello', null, '10:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:45', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '17:00', '19:55', 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'ischia', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'lacco', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'casamicciola', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, null),
  ('aleste', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'flight', 'aliscafo', null, 'barano', '20:00', '23:55', 'alilauro', '16:15', 'ischia_porto', 'napoli_beverello', null, '15:00', null, null, null, null);

-- snav: 50 regole statiche -> 99 righe DB
insert into public.ferry_pickup_rules
  (agency_logic, direction, transport_type, boat_type, hotel_id, zone,
   transport_from, transport_to, company, departure_time, embark_port, arrival_port, arrival_time,
   pickup_time, valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '07:10', 'casamicciola', 'napoli_beverello', null, '06:20', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '09:45', 'casamicciola', 'napoli_beverello', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:40', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:40', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:45', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:45', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:45', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:45', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:15', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:15', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '10:30', 'casamicciola', 'napoli_beverello', null, '08:30', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:30', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:30', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '12:50', 'casamicciola', 'napoli_beverello', null, '11:45', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-06', '2026-09-13', '{0,1,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-06', '2026-09-13', '{0,1,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:50', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:30', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:30', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '13:15', 'casamicciola', 'napoli_beverello', null, '11:45', '2026-06-06', '2026-09-13', '{0,1,5,6}', 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:40', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:40', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:50', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:50', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:00', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '14:00', 'casamicciola', 'napoli_beverello', null, '12:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-05-02', '2026-05-30', '{0,5}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-06-01', '2026-09-30', null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-05-02', '2026-05-30', '{0,5}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-06-01', '2026-09-30', null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-05-02', '2026-05-30', '{0,5}', 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-06-01', '2026-09-30', null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-05-02', '2026-05-30', '{0,5}', 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:15', '2026-06-01', '2026-09-30', null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:30', '2026-05-02', '2026-05-30', '{0,5}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:30', '2026-06-01', '2026-09-30', null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:30', '2026-05-02', '2026-05-30', '{0,5}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:30', '2026-06-01', '2026-09-30', null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:00', '2026-05-02', '2026-05-30', '{0,5}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:00', '2026-06-01', '2026-09-30', null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:00', '2026-05-02', '2026-05-30', '{0,5}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:00', '2026-06-01', '2026-09-30', null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:00', '2026-05-02', '2026-05-30', '{0,5}', 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '15:15', 'casamicciola', 'napoli_beverello', null, '14:00', '2026-06-01', '2026-09-30', null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:45', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:50', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:50', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:50', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:50', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:30', null, null, null, null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '17:40', 'casamicciola', 'napoli_beverello', null, '16:45', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:15', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:15', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:30', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:30', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:30', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:30', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:00', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '17:00', '2026-06-01', '2026-09-28', '{0,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '18:30', 'casamicciola', 'napoli_beverello', null, '16:45', '2026-06-01', '2026-09-28', '{0,5,6}', 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'ischia', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'lacco', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'casamicciola', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('sosandra', 'from_ischia', 'direct', 'aliscafo', null, 'barano', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', null),
  ('aleste', 'from_ischia', 'direct', 'aliscafo', null, 'forio', null, null, 'snav', '20:00', 'casamicciola', 'napoli_beverello', null, '19:00', '2026-06-06', '2026-09-13', '{0,1,5,6}', 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno');

-- medmar: 50 regole statiche -> 50 righe DB
insert into public.ferry_pickup_rules
  (agency_logic, direction, transport_type, boat_type, hotel_id, zone,
   transport_from, transport_to, company, departure_time, embark_port, arrival_port, arrival_time,
   pickup_time, valid_from, valid_to, days_of_week, season_notes)
values
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '06:25', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '06:25', 'ischia_porto', 'napoli_beverello', null, '05:20', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '06:25', 'ischia_porto', 'napoli_beverello', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '06:25', 'ischia_porto', 'napoli_beverello', null, '05:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '06:25', 'ischia_porto', 'napoli_beverello', null, '05:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '10:35', 'ischia_porto', 'napoli_beverello', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '10:35', 'ischia_porto', 'napoli_beverello', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '10:35', 'ischia_porto', 'napoli_beverello', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '10:35', 'ischia_porto', 'napoli_beverello', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '10:35', 'ischia_porto', 'napoli_beverello', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '17:00', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '17:00', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '17:00', 'ischia_porto', 'napoli_beverello', null, '15:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '17:00', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '17:00', 'ischia_porto', 'napoli_beverello', null, '15:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:20', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '06:20', 'casamicciola', 'pozzuoli', null, '05:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:20', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:10', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '08:10', 'ischia_porto', 'pozzuoli', null, '07:00', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:40', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '10:10', 'casamicciola', 'pozzuoli', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:45', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '13:35', 'casamicciola', 'pozzuoli', null, '12:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '16:50', 'casamicciola', 'pozzuoli', null, '15:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '16:50', 'casamicciola', 'pozzuoli', null, '15:30', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '16:50', 'casamicciola', 'pozzuoli', null, '15:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '16:50', 'casamicciola', 'pozzuoli', null, '15:15', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '16:50', 'casamicciola', 'pozzuoli', null, '15:15', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '11:10', 'ischia_porto', 'pozzuoli', null, '09:30', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '11:10', 'ischia_porto', 'pozzuoli', null, '08:40', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '11:10', 'ischia_porto', 'pozzuoli', null, '08:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '11:10', 'ischia_porto', 'pozzuoli', null, '09:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '11:10', 'ischia_porto', 'pozzuoli', null, '08:30', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'ischia', null, null, 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'lacco', null, null, 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, 'Hotel Augusto: carico Bar Campo'),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'casamicciola', null, null, 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '14:00', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'barano', null, null, 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '13:45', null, null, null, null),
  ('aleste', 'from_ischia', 'direct', 'traghetto', null, 'forio', null, null, 'medmar', '15:00', 'ischia_porto', 'pozzuoli', null, '13:45', null, null, null, 'Hotel Colella: angolo strada autoscuola San Lorenzo · Hotel La Rosa: AM Mototi · Villa Teresa: discesa strada principale · Royal Pal: discesa hotel · Punta del Sole: Hotel Nettuno');


  end if;
end $$;

-- Rollback (commentato, non eseguire automaticamente):
-- delete from public.ferry_pickup_rules where direction = 'from_ischia';
