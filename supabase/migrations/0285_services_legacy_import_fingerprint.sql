-- Migration 0285: services.legacy_import_fingerprint — chiude il gap di
-- concorrenza residuo sulla dedupe dell'import Excel LEGACY
-- (app/api/excel/import/route.ts).
--
-- GAP: la dedupe attuale fa un lookup (SELECT su services filtrate per
-- tenant+data, status<>'cancelled') PRIMA dell'insert, poi confronta il
-- fingerprint applicativo (buildImportFingerprint: date+time+direction+
-- hotel_id+customer_name+pax+transport_code+billing_party_name, normalizzati
-- con normalizeLooseText). Due upload identici avviati nello stesso momento
-- possono entrambi superare il lookup prima che l'altro abbia scritto:
-- nessuna protezione DB, solo SELECT-then-INSERT applicativo.
--
-- PERCHE' NON un unique index/expression index "a tabella intera": le stesse
-- colonne (date/time/direction/hotel_id/customer_name/pax/transport_code/
-- billing_party_name) sono scritte anche da operational-v2, MTS Globe,
-- creazione manuale e round-trip — un vincolo su quelle colonne senza
-- scoping avrebbe bloccato righe legittime create da flussi NON legacy
-- (violando il requisito esplicito "nessuna modifica ai flussi non
-- legacy"). Nessuno di questi altri flussi ha oggi un discriminatore
-- "origine legacy import" riusabile in services.
--
-- SOLUZIONE: colonna fingerprint PERSISTITA, scritta SOLO da
-- app/api/excel/import/route.ts con l'output letterale della funzione JS
-- buildImportFingerprint gia' esistente (stessa identica stringa usata per
-- il lookup applicativo pre-insert) — zero rischio di drift tra la
-- normalizzazione app (normalizeLooseText: lowercase + NFD + strip
-- diacritici + collasso non-alfanumerici, difficile da replicare in modo
-- identico come expression SQL) e il valore effettivamente confrontato dal
-- DB. Tutti gli altri flussi non scrivono questa colonna: resta NULL, il
-- partial index (WHERE legacy_import_fingerprint IS NOT NULL) non li
-- coinvolge mai. Nessun trigger necessario: a differenza di
-- booking_group_bus_reservations (migration 0284, regola cross-row
-- condizionale sul valore booleano exclusive), qui la regola e' una pura
-- unicita' "mai due righe con lo stesso fingerprint per lo stesso tenant"
-- - un unique index parziale e' gia' nativamente atomico sotto concorrenza
-- reale in Postgres (due INSERT concorrenti con lo stesso valore: una sola
-- commit, l'altra riceve 23505).
--
-- VERIFICA DATI LIVE (pre-migration, sola SELECT, eseguita su progetto
-- ischia-transfer): screening sull'intera tabella services con
-- normalizzazione SQL equivalente a normalizeLooseText, status<>'cancelled'
-- -> 0 duplicati trovati secondo la stessa logica del fingerprint. Nessuna
-- remediation di dati necessaria. Colonna nuova e vuota su tutte le righe
-- storiche: nessun backfill possibile ne' necessario, la protezione vale
-- solo per i nuovi insert da questa route in avanti (stesso perimetro del
-- gap descritto: la dedupe storica pre-insert applicativa resta invariata).
--
-- STATUS 'cancelled' escluso dal vincolo, coerente con la logica
-- applicativa esistente (.neq("status","cancelled") nel lookup pre-insert):
-- un servizio cancellato con lo stesso fingerprint non deve bloccare un
-- nuovo import identico.
--
-- DECISIONE ESPLICITA (audit pre-rollout, scenario cancel -> reimport ->
-- restore): legacy_import_fingerprint NON viene MAI azzerato quando un
-- servizio passa a status='cancelled' (ne' dalla RPC cancel_service_practice
-- ne' da un trigger dedicato — nessuno dei due introdotto). Se lo si
-- azzerasse, un vecchio servizio cancellato S1(X) potrebbe essere
-- ripristinato con fingerprint NULL e convivere silenziosamente con un
-- reimport S2(X) gia' attivo, ricreando due servizi equivalenti attivi —
-- esattamente il duplicato che questo vincolo esiste per impedire. Effetto
-- collaterale accettato: se S1(X) viene cancellato, poi reimportato come
-- S2(X), un successivo tentativo di ripristinare S1 (route
-- app/api/ops/services/[id]/replace, unico punto che riporta status
-- cancelled -> new) collide sul partial index sottostante quando S2 e'
-- ancora attivo con lo stesso fingerprint. Gestito ESCLUSIVAMENTE in
-- quella route con un catch mirato su SQLSTATE 23505 + nome di questo
-- vincolo, mappato a un 409 di business chiaro — mai un 500 generico, mai
-- il messaggio Postgres grezzo esposto. Nessun'altra route non-legacy
-- modificata.
--
-- Idempotente: "add column if not exists" + "create unique index if not
-- exists". Additiva e non distruttiva: nessuna colonna esistente toccata,
-- nessun dato riscritto.

alter table public.services
  add column if not exists legacy_import_fingerprint text null;

comment on column public.services.legacy_import_fingerprint is
  'Fingerprint di dedupe scritto SOLO da app/api/excel/import/route.ts (buildImportFingerprint): date+time+direction+hotel_id+customer_name+pax+transport_code+billing_party_name normalizzati. NULL per ogni riga creata da altri flussi (operational-v2, MTS Globe, manuale, round-trip): non partecipano al vincolo di unicita' sottostante.';

create unique index if not exists uq_services_legacy_import_fingerprint
  on public.services (tenant_id, legacy_import_fingerprint)
  where legacy_import_fingerprint is not null and status <> 'cancelled';

-- ROLLBACK logico (non eseguito qui, solo documentato):
--   drop index if exists public.uq_services_legacy_import_fingerprint;
--   alter table public.services drop column if exists legacy_import_fingerprint;
-- Sicuro: nessun'altra colonna o vincolo dipende da questa, nessun dato
-- storico perso (la colonna e' scritta solo in avanti da questo momento).
