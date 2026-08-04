# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 18 TASK CRITICAL/HIGH/MEDIUM COMPLETATI E PUSHATI, RIALLINEAMENTO FINALE DOPO FUNC-03 SU CREATE_TRIP (2026-08-04)

- **Branch**: main
- **HEAD attuale**: `0e769d2` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-08-04)
- **Worktree**: pulito (`git status --short` vuoto; cartella `exports/` non presente/non tracciata in questa sessione — da ignorare comunque se ricompare, non aprire, non modificare)
- **Data ultimo riallineamento**: 2026-08-04 (sessione read-only, nessun codice/test modificato in questa sessione)

## Task completati (in ordine di commit)

| # | ID | Titolo | Commit | Test dedicati | Reviewer |
|---|---|---|---|---|---|
| 1 | SEC-01 | Tenant guard su `departure-bus-assign` | `27f5624` | `tests/unit/departure-bus-assign-tenant-isolation.test.ts` (13 casi) | APPROVATO |
| 2 | SEC-02 | Tenant guard su `piano-giorno/trips` (create_trip/update_trip/move_services) | `966f2a5` | `tests/unit/piano-giorno-trips-tenant-isolation.test.ts` | APPROVATO |
| 3 | CONC-01 | Controllo errore insert in `assign-service` (falso successo + trip_groups orfano) | `b33ce74` | `tests/unit/assign-service-concurrency.test.ts` (20 casi) | APPROVATO |
| 4 | FUNC-01 | Disponibilità giornaliera + compatibilità geografica batch in `departure-bus-assign` | `6235acb` | `tests/unit/departure-bus-assign-operational-validation.test.ts` (19 casi) | APPROVATO (funzionale + indipendente) |
| 5 | SEC-05 | Tenant ownership driver in `assign-service` (perimetro: sola route `assign-service`) | `2712d76` | `tests/unit/assign-service-driver-tenant-guard.test.ts` (nuovo) | APPROVATO |
| 6 | RACE-01 | UPSERT atomico al posto di DELETE+INSERT in `departure-bus-assign` (`assign_driver`) | `c44f6d9` | `tests/unit/departure-bus-assign-race.test.ts` (nuovo) | APPROVATO |
| 7 | RACE-01 (semantica upsert) | Reset esplicito metadati stale (`driver_profile_id`, `group_id`, `assignment_source`, `locked_by_operator`, `lock_reason`) + `assigned_by`/`assigned_at` | `983e1a1` | `tests/unit/departure-bus-assign-upsert-semantics.test.ts` (nuovo) | APPROVATO |
| 8 | CONC-03 | Overlap mezzo bloccante in `assign-service` (riusa `vehicleIntervalsOverlap`) | `3976d4c` | `tests/unit/assign-service-vehicle-overlap.test.ts` (nuovo) | APPROVATO |
| 9 | SEC-05 residuo | Tenant ownership driver in `departure-bus-assign` (`assign_driver`) | `4307c18` | `tests/unit/departure-bus-assign-driver-tenant-guard.test.ts` (nuovo) | APPROVATO |
| 10 | FUNC-02 | Guard stato servizio (denylist su enum reale + `is_draft`) in `assign-service` | `1089b9f` | `tests/unit/assign-service-status-guard.test.ts` (24 casi, nuovo) | APPROVATO (funzionale + indipendente) |
| 11 | FUNC-03 | Guard operatività driver (`memberships.suspended`/`driver_profiles.active`) in `assign-service` | `e05c43b` | `tests/unit/assign-service-driver-status-guard.test.ts` (20 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |
| 12 | SEC-04 | Titolarità driver su `driver-status` (`assignments.driver_user_id = auth.user.id`, solo ruolo driver) | `6d66f06` | `tests/unit/driver-status-access-control.test.ts` (nuovo) | APPROVATO (security + indipendente) |
| 13 | CONC-02 | Overlap orario reale stesso autista in `assign-service` (`driver_user_id` e/o `driver_profile_id`) | `21a25cb` | `tests/unit/assign-service-driver-overlap.test.ts` (20 casi, nuovo) | APPROVATO (security + indipendente) |
| 14 | CONC-03 residuo | Overlap mezzo esterno al batch in `departure-bus-assign` (nessun conflitto interno: batch = giro coordinato) | `7c5d081` | `tests/unit/departure-bus-assign-vehicle-overlap.test.ts` (19 casi, nuovo) | APPROVATO (database/concurrency + indipendente) |
| 15 | CONC-02 residuo | Overlap driver esterno al batch in `departure-bus-assign`, stesso schema di CONC-03 residuo | `3d8356a` | `tests/unit/departure-bus-assign-driver-overlap.test.ts` (21 casi, nuovo) | APPROVATO (database/concurrency + indipendente) |
| 16 | SEC-05 residuo | Tenant ownership driver in `piano-giorno/trips`, azione `create_trip` | `1e10f0c` | `tests/unit/piano-giorno-trips-driver-tenant-guard.test.ts` (nuovo) | APPROVATO |
| 17 | FUNC-02 residuo | Guard stato servizio in `piano-giorno/trips`, azione `create_trip` | `7243e3e` | `tests/unit/piano-giorno-trips-service-status-guard.test.ts` (nuovo) | APPROVATO |
| 18 | FUNC-03 residuo | Guard operatività driver in `piano-giorno/trips`, azione `create_trip` | `0e769d2` | `tests/unit/piano-giorno-trips-driver-status-guard.test.ts` (24 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |

Tutti e 18 verificati presenti nel codice reale in questa sessione di riallineamento (grep sui marker chiave: `verifyDriverBelongsToTenant`/`DRIVER_NOT_ACTIVE` in `assign-service.ts`, `VEHICLE_OVERLAP`/`DRIVER_OVERLAP` in `assign-service.ts` e `departure-bus-assign.ts`, `DRIVER_STATUS_FORBIDDEN` in `driver-status.ts`, `verifyTripDriverBelongsToTenant`/`verifyTripServicesOperationalStatus`/`verifyTripDriverIsOperational` in `trips/route.ts`, più esistenza dei 18 file di test dedicati). Sessione di riallineamento puramente read-only: nessun test rieseguito in questa sessione (già verificati verdi nelle sessioni di implementazione precedenti), nessun codice toccato. **Lettura integrale in questa sessione**: `app/api/ops/piano-giorno/trips/route.ts` (le 7 action per intero, incluse `update_trip`/`move_services`/`swap_driver`/`swap_vehicle`), `app/api/ops/piano-giorno/auto-assign/route.ts` (rilettura mirata CONC-06), `app/api/ops/assign-service/route.ts` (rilettura mirata SEC-03/CONC-07).

## Analisi mirata `piano-giorno/trips` (sessioni 2026-08-03/2026-08-04, lettura integrale del file)

Il file (~1700 righe) implementa 7 action (`create_trip`, `update_trip`, `delete_trip`, `move_services`, `swap_driver`, `swap_vehicle`, `delay_vessel`). SEC-05/FUNC-02/FUNC-03 sono stati chiusi su `create_trip` nelle sessioni 2026-08-03/04 (`1e10f0c`, `7243e3e`, `0e769d2`). Rivalutazione aggiornata:

| Finding | Gap ancora reale? | Evidenza | Conclusione |
|---|---|---|---|
| CONC-03 (overlap mezzo) | **No** | `validateVehicleTimelinePayload` (righe ~1500+) esegue un vero controllo overlap mezzo con blocco reale su `create_trip`/`update_trip`/`move_services`, preesistente e mai toccato da questa milestone | **Non è un gap** — conferma l'audit originale ("trips" = percorso più validato) |
| CONC-02 (overlap driver) | **No** | `evaluateDriverTimelineConflicts` (righe ~1165+) blocca realmente quando `availableMinutes<=5` tra due servizi consecutivi dello stesso driver, non solo un'euristica di zona | **Non è un gap** — stesso motivo |
| SEC-05 (tenant ownership driver) su `create_trip` | **No, chiuso** | `verifyTripDriverBelongsToTenant()` (riga 942, invocata riga 100) — commit `1e10f0c` | **CHIUSO** |
| SEC-05 su `update_trip`/`delete_trip`/`move_services`/`swap_driver`/`swap_vehicle`/`delay_vessel` | **Sì** | Grep in questa sessione: `verifyTripDriverBelongsToTenant(` compare **una sola volta** in tutto il file (riga 100, dentro `create_trip`). `update_trip` (righe 238-448) e `move_services` (righe 492-683) accettano `driver_user_id`/`driver_profile_id` dal client e li scrivono su `trip_groups`/`assignments` senza alcuna verifica esplicita di tenant ownership (stessa protezione solo incidentale via `driver_daily_availability` già nota). `swap_driver` (righe 686-742) accetta `to_driver_id` client-controlled e lo scrive su tutti i gruppi attivi del giorno senza alcuna verifica di ownership | **Gap confermato**, MEDIUM |
| FUNC-02 (stato servizio) su `create_trip` | **No, chiuso** | `verifyTripServicesOperationalStatus()` (riga 1046, invocata riga 112) — commit `7243e3e` | **CHIUSO** |
| FUNC-02 sulle altre 6 action | **Sì** | Grep: `verifyTripServicesOperationalStatus(` compare una sola volta, solo in `create_trip` | **Gap confermato**, MEDIUM |
| FUNC-03 (driver sospeso) su `create_trip` | **No, chiuso** | `verifyTripDriverIsOperational()` (riga 1118, invocata riga 126) — commit `0e769d2`, incluso cleanup di un blocco di commento duplicato rilevato e corretto in questa sessione (nessun impatto funzionale) | **CHIUSO** |
| FUNC-03 sulle altre 6 action | **Sì** | Grep: `verifyTripDriverIsOperational(` compare una sola volta, solo in `create_trip`; `update_trip`/`move_services`/`swap_driver` possono assegnare un driver sospeso/inattivo senza blocco | **Gap confermato**, MEDIUM |

**Conclusione**: CONC-02/CONC-03 residui su `trips` restano non-gap (invariato). SEC-05/FUNC-02/FUNC-03 sono chiusi solo su `create_trip`; restano aperti sulle 6 action rimanenti — priorità decrescente `update_trip` > `move_services` > `swap_driver` (le altre tre azioni non toccano `driver_user_id`/`driver_profile_id`/servizi in scrittura con lo stesso profilo di rischio).

## Rivalutazione finding aperti (sessione 2026-08-04, riallineamento finale post-FUNC-03 su create_trip)

| ID | Titolo | Severità | Stato | Rischio operativo | Dipendenze | Difficoltà | Rischio regressione | Stima tempo | Adatto come prossimo task atomico? |
|---|---|---|---|---|---|---|---|---|---|
| SEC-05 (trips, `create_trip`) | — | MEDIUM | **CHIUSO** (`1e10f0c`) | — | — | — | — | — | — |
| FUNC-02 (trips, `create_trip`) | — | MEDIUM | **CHIUSO** (`7243e3e`) | — | — | — | — | — | — |
| FUNC-03 (trips, `create_trip`) | — | MEDIUM | **CHIUSO** (`0e769d2`) | — | — | — | — | — | — |
| SEC-05 (trips, `update_trip`/`move_services`/`swap_driver`) | driver_user_id/driver_profile_id non verificati esplicitamente contro il tenant nelle 6 action non-`create_trip` | MEDIUM | APERTO — **prossimo task scelto (`update_trip`)** | Medio: mitigato indirettamente da `driver_daily_availability` (tenant-scoped), ma non è un controllo esplicito — un cambio futuro a quella tabella romperebbe silenziosamente la protezione | Nessuna diretta | S | Basso (pattern già collaudato 3 volte: `assign-service`, `departure-bus-assign`, `trips create_trip`; helper `verifyTripDriverBelongsToTenant` già generico, riusabile senza duplicazione) | ~1 sessione | **Sì** — perimetro riducibile a una sola action (`update_trip`), no migrazione, no UI, rollback singolo commit |
| FUNC-02 (trips non-`create_trip`/departure-bus-assign) | Nessun guard stato servizio | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service`/`create_trip` | Medio: stesso rischio già mitigato altrove, ora relativamente più visibile come incoerenza tra action | Nessuna | S | Basso (denylist e helper già definiti e testati) | ~1 sessione | Sì |
| FUNC-03 (trips non-`create_trip`/departure-bus-assign) | Nessun guard operatività driver | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service`/`create_trip` | Basso-medio: operativo, non sicurezza | Nessuna | S | Basso (helper già scritto, da clonare) | ~1 sessione | Sì |
| SEC-03 | Join `services!inner` senza filtro tenant esplicito | HIGH (originale) → **MEDIUM** (rivalutato) | APERTO — rivalutato ulteriormente in questa sessione: rischio ridotto ancora di più ora che SEC-05 è chiuso anche su `create_trip` (oltre a `assign-service`/`departure-bus-assign`) | Basso-medio: rischio ridotto perché SEC-01/SEC-02/SEC-05 ora impediscono la creazione di `assignments` cross-tenant a monte su tutte le route/azioni più usate — questo resta un gap di difesa-in-profondità, non più uno sfruttabile diretto noto | Nessuna | XS per file, ma tocca 2 file (`assign-service.ts`, `trips.ts`) | Molto basso | Poche ore per file | Sì se atomizzato a un solo file per volta, altrimenti no (criterio "una sola route") |
| CONC-06 | Snapshot `locked_by_operator` non rivalidato al commit in `auto-assign` regenerate_all | HIGH | APERTO — riletto integralmente in questa sessione (righe ~965 snapshot, ~1829-1878 upsert finale): nessuna rilettura di `locked_by_operator` immediatamente prima dell'upsert, gap confermato invariato | Medio: finestra di race stretta, richiede due operatori attivi in contemporanea sullo stesso giorno | Nessuna | M | **Medio-alto** — `auto-assign/route.ts` è un file da 1955 righe, area ad alta complessità, rischio di regressione più concreto | Più di 1 sessione probabile | **No** — file grande, fuori dal criterio "singola sessione a basso rischio"; escluso esplicitamente da questa sessione |
| SEC-06 | Error leak sistemico (messaggi Supabase raw) | MEDIUM | APERTO — confermato multi-file in questa sessione: `trips/route.ts` (righe 195, 564, 898, 1308, 1612, 1706), `dispatch-data/route.ts:36,53`, `driver-assignment-history/route.ts:118,136-137` | Basso: information disclosure sullo schema, non leak dati cross-tenant | Nessuna | M (multi-file) | Basso | 1-2 sessioni | **No** — tocca più route contemporaneamente, non "una sola route" |
| CONC-07 | `assign-service` non scrive audit trail business-level | MEDIUM | APERTO — confermato in questa sessione: zero occorrenze di `logAssignmentChange` in `assign-service/route.ts` | Basso: gap di osservabilità, non di sicurezza/integrità | Nessuna | S | Basso | ~1 sessione | Sì, ma priorità bassa (non blocca operatività) |
| M1-08, M1-09, M1-11, M1-14 | (vedi checklist per dettaglio) | vario | APERTO | vario | — | — | — | — | vedi righe sopra (SEC-03=M1-08, CONC-06=M1-09, SEC-06=M1-11, CONC-07=M1-14) |
| TEST-01/TEST-03 | Copertura test HTTP-level/tenant isolation | HIGH (originale) → **LARGAMENTE MITIGATO** | quasi CHIUSO per `assign-service`/`departure-bus-assign` | Basso ora | — | — | — | — | Non è più un task a sé, effetto collaterale dei fix comportamentali |
| Lock/source asimmetria | `locked_by_operator`/`assignment_source` diversi tra route | INFO | **CHIUSO come non-issue** | — | — | — | — | — | — |
| RACE-01 | DELETE+INSERT non atomico | MEDIUM/HIGH | **CHIUSO** | — | — | — | — | — | — |
| SEC-04 | Broken access control orizzontale in `driver-status` | HIGH | **CHIUSO** (`6d66f06`) | — | — | — | — | — | — |
| CONC-02 (assign-service + departure-bus-assign) | Overlap orario stesso driver | HIGH | **CHIUSO su entrambe le route** (`21a25cb`, `3d8356a`) | — | — | — | — | — | — |
| CONC-03 (assign-service + departure-bus-assign) | Overlap mezzo | HIGH | **CHIUSO su entrambe le route** (`3976d4c`, `7c5d081`) | — | — | — | — | — | — |
| CONC-02/CONC-03 (trips) | Overlap driver/mezzo su `piano-giorno/trips` | HIGH (originale) → **NON UN GAP** | **CHIUSO come non-issue** (mai stato un gap: guard preesistenti già reali) | — | — | — | — | — | — vedi analisi mirata sopra |
| DB-01/DB-02/DB-07, ML-01/ML-02, TEST-02/04/05, UI-* | (vedi audit §24) | vario | APERTO, non rivalutati in dettaglio | — | — | — | — | — | No — richiedono design/migrazione o toccano UI/ML, fuori dai criteri di "prossimo task atomico" |

**Nessun finding chiuso indirettamente in questa sessione** (puramente read-only): i 18 task completati nelle sessioni precedenti sono stati solo verificati, non modificati. CONC-02/CONC-03 su `trips` restano riclassificati come non-gap (invariato dalla sessione precedente).

## Top 10 priorità finale M1 (criteri: sicurezza + corruzione dati + falso successo + impossibilità operativa + concorrenza + stato servizio/driver + audit + UX + performance + ML)

1. **SEC-05 residuo** (`trips`, azioni `update_trip`/`move_services`/`swap_driver`, MEDIUM) — unico gap di sicurezza/tenant-ownership ancora aperto in questa milestone; protezione solo incidentale, fragile a refactoring futuri non correlati. Stima S. — **prossimo task scelto (`update_trip`)**.
2. **FUNC-02 residuo** (`trips` azioni non-`create_trip`/`departure-bus-assign`, MEDIUM) — denylist già pronta da clonare.
3. **FUNC-03 residuo** (`trips` azioni non-`create_trip`/`departure-bus-assign`, MEDIUM) — helper già pronto da clonare.
4. **CONC-06** (HIGH ma penalizzato per complessità/rischio regressione) — rivalidazione lock in `auto-assign`, file da 1955 righe, non adatto a "singola sessione a basso rischio" ma severità intrinseca alta. Esplicitamente esclusa in questa sessione per la stessa ragione.
5. **SEC-03** (rivalutato MEDIUM, rischio residuo ulteriormente ridotto dopo la chiusura di SEC-05 su `create_trip`) — filtro tenant esplicito sul join, difesa in profondità, 2 file.
6. **CONC-07** (MEDIUM) — audit trail mancante su `assign-service`, gap di osservabilità non di sicurezza.
7. **SEC-06** (MEDIUM, multi-file) — sanitizzazione errori Supabase raw, rischio basso (information disclosure schema).
8. **M2-\*** (strutturali: EXCLUDE constraint DB, RPC transazionali, lock collaborativo, unificazione scoring) — richiedono design multi-sessione, fuori scope per task atomici singoli.
9. **M1.5-\*** (UX: conferme distruttive, mis-click, accessibilità) — basso costo ma non bloccanti per produzione.
10. **M2-05..M2-09** (ML/test/performance residui) — bassa urgenza operativa.

## Decisione Milestone 1 (sessione 2026-08-04)

**B) Milestone 1 richiede 2-3 task residui.** Motivazione: SEC-05/FUNC-02/FUNC-03 sono chiusi solo su `create_trip`; le altre 6 action di `trips` (in particolare `update_trip`, `move_services`, `swap_driver`, che scrivono `driver_user_id`/`driver_profile_id` client-controlled) restano gap reali confermati via grep in questa sessione, non chiudibili in un solo task senza mescolare più action in un commit (viola la regola "un task alla volta, atomico"). Non si dichiara "nessun rischio": CONC-06 (HIGH) resta aperto e rinviato per complessità/dimensione del file, non per assenza di rischio reale — verrà rivalutato come priorità M1 dopo la chiusura dei task SEC-05/FUNC-02/FUNC-03 residui sulle azioni rimanenti di `trips`.

## Prossimo task scelto: SEC-05 residuo su `piano-giorno/trips`, azione `update_trip`

**Motivazione**: tra i candidati confrontati (A: SEC-05 residuo `update_trip`: MEDIUM, unico gap di sicurezza reale rimasto, azione a più alto traffico dopo `create_trip`; B: FUNC-02/FUNC-03 residui: MEDIUM ma categoria "stato servizio/driver", priorità #6; C: CONC-02/CONC-03 residui trips: **non un gap reale**, esclusi; D: SEC-03: MEDIUM rivalutato, rischio residuo basso, 2 file — meno atomico di un singolo task su una singola action; E: SEC-06: MEDIUM ma multi-route, esclude il criterio "una sola route"; F: CONC-07: MEDIUM ma categoria "audit", priorità #6; G: CONC-06: HIGH ma file da 1955 righe, rischio di regressione troppo alto per una singola sessione a basso rischio, esplicitamente escluso dalle istruzioni di questa sessione), **SEC-05 residuo su `update_trip`** è il candidato di categoria sicurezza (priorità #1) più prioritario ancora realmente aperto e atomico: soddisfa tutti i criteri richiesti (1 route, 1 action, nessuna migrazione, nessuna UI, rollback a singolo commit, testabile a livello handler, pattern già collaudato 3 volte — inclusa la stessa route su `create_trip`).

## Perimetro del prossimo task (SEC-05 su `piano-giorno/trips`, action `update_trip`) — non implementato

- **Finding**: SEC-05 — `piano-giorno/trips/route.ts`, action `update_trip` (righe 238-448), non verifica che `driver_user_id`/`driver_profile_id` ricevuti dal client appartengano al tenant autenticato prima di scrivere `trip_groups`/`assignments`. `verifyServiceIdsBelongToTenant` (SEC-02, riga 257) copre solo l'ownership dei `service_ids` opzionali; nessun equivalente per il driver.
- **Causa**: nessuna query su `memberships`/`driver_profiles` filtrata per tenant prima della scrittura in questa action; l'unica protezione è indiretta (righe assenti in `driver_daily_availability` per un driver esterno, dentro `validateTripPayload`).
- **Route/Action**: `app/api/ops/piano-giorno/trips/route.ts`, **solo `update_trip`** (perimetro ridotto per atomicità — `move_services`/`swap_driver` restano follow-up separati dello stesso finding).
- **File**: `app/api/ops/piano-giorno/trips/route.ts` soltanto. **Nessun nuovo helper da scrivere**: `verifyTripDriverBelongsToTenant()` (riga 942) è già generico (accetta `driverUserId`/`driverProfileId`/`context.action`), va solo invocato una seconda volta con `action: "update_trip"`.
- **Guard**: invocare `verifyTripDriverBelongsToTenant(auth.admin, tenantId, { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null }, { actorUserId: userId, action: "update_trip" })` subito dopo il controllo `verifiedServiceIds`/`ownership` (SEC-02, dopo riga 263) e prima di `ensureAvailabilityConfirmed`/`validateTripPayload` (riga 265).
- **Query**: identiche a quelle già scritte per `create_trip` (nessuna nuova query da progettare) — `memberships.select("suspended").eq("tenant_id",tenantId).eq("user_id",driverUserId).eq("role","driver").maybeSingle()` per l'ownership (nota: il campo selezionato per SEC-05 è quello usato da `verifyTripDriverBelongsToTenant`, verificare la firma esatta leggendo la funzione prima di invocarla) e query analoga su `driver_profiles`.
- **Status HTTP**: `404 DRIVER_NOT_FOUND` per ownership; `500` fail-closed su errore query (stesso codice già usato da `verifyTripDriverBelongsToTenant` per `create_trip`, verificare nome esatto leggendo il codice).
- **Risposta JSON**: identica a quella già prodotta da `verifyTripDriverBelongsToTenant` per `create_trip` (stessa funzione, stesso output).
- **Test**: nuovo file `tests/unit/piano-giorno-trips-update-driver-tenant-guard.test.ts` — driver same-tenant (successo, invariato), driver cross-tenant/inesistente (404), coppia user/profile incoerente (404), errore query (500 fail-closed), `create_trip`/`delete_trip`/`move_services`/`swap_driver`/`swap_vehicle`/`delay_vessel` invariate, `service_ids` opzionale assente/presente invariato, SEC-02/FUNC-02/FUNC-03/overlap mezzo-driver preesistenti su `update_trip` invariati.
- **Fail-closed**: sì — errore di query blocca l'aggiornamento del giro, non procede in silenzio.
- **Regressioni**: nessuna prevista — task additivo; verificare che non rompa il flusso legittimo `update_trip` senza cambio driver (campi opzionali, guard va saltato se entrambi assenti, come già in `create_trip`).
- **Rollback**: revert del singolo commit dedicato.
- **Definition of Done**: come da `assignments-hardening-checklist.md`.
- **Commit suggerito**: `fix: verify driver tenant ownership before update_trip in piano-giorno trips (SEC-05 residuo)`.

I candidati immediatamente successivi, in ordine: SEC-05 su `move_services`/`swap_driver`; poi FUNC-02/FUNC-03 residui (stato servizio/driver sospeso) sulle stesse azioni e su `departure-bus-assign`; poi SEC-03 (atomizzato per file), CONC-07, SEC-06, infine CONC-06 (M1, ma richiede una sessione dedicata per il rischio di regressione sul file da 1955 righe).

## Cose da NON modificare

- WhatsApp (template, webhook Meta, invii, convocazioni) — fuori perimetro assoluto.
- Web Push, email, notifiche in generale — non toccate né da questa sessione di riallineamento né dai quattro fix.
- `docs/audits/assignments-module-audit.md` — audit storico, non modificato in questa sessione (né in nessuna sessione di hardening successiva): resta il documento di riferimento originale del 2026-07-31, le rivalutazioni vivono in questo file e nella checklist.
- `lib/server/piano-driver-swap-preview.ts` — contiene un caso hardcoded specifico ("GPR_PETER", data 2026-05-07); qualunque refactoring di quell'area richiede conferma esplicita che il caso reale non sia più attivo prima di generalizzare/rimuovere.
- Nessun task M1/M1.5 rimuove funzionalità esistente — sono tutti additivi (nuovi controlli) o correzioni di gestione errori.
- `exports/` — cartella locale preesistente, non tracciata, non correlata: ignorare sempre, non aprire/modificare/aggiungere/cancellare.

## Comandi per riprendere da un'altra postazione

```bash
git status --short
git log --oneline -8
cat docs/plans/assignments-working-status.md
cat docs/plans/assignments-hardening-checklist.md
```

Poi partire dal "Prossimo task scelto" sopra (SEC-05 residuo su `piano-giorno/trips/route.ts`, azione `update_trip`), seguendo il Definition of Done della checklist. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
