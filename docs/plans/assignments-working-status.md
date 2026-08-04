# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 23 TASK CRITICAL/HIGH/MEDIUM COMPLETATI E PUSHATI, RIALLINEAMENTO DOPO PACCHETTO UPDATE_TRIP + SWAP_DRIVER (2026-08-04)

- **Branch**: main
- **HEAD attuale**: `052e7c9` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` in questa sessione)
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
| 19 | SEC-05 residuo | Tenant ownership driver in `piano-giorno/trips`, azione `update_trip` (riuso helper) | `f6492d2` | `tests/unit/piano-giorno-trips-update-driver-tenant-guard.test.ts` (21 casi, nuovo) | APPROVATO |
| 20 | FUNC-02 residuo | Guard stato servizio in `piano-giorno/trips`, azione `update_trip` (insieme finale post-merge parziale, riuso helper) | `c227d26` | `tests/unit/piano-giorno-trips-update-service-status-guard.test.ts` (36 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |
| 21 | FUNC-03 residuo | Guard operatività driver in `piano-giorno/trips`, azione `update_trip` (riuso helper) | `5166c46` | `tests/unit/piano-giorno-trips-update-driver-status-guard.test.ts` (22 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |
| 22 | SEC-05 residuo | Tenant ownership target driver in `piano-giorno/trips`, azione `swap_driver` (riuso helper, contratto reale `to_driver_id`) | `530fd38` | `tests/unit/piano-giorno-trips-swap-driver-tenant-guard.test.ts` (25 casi, nuovo) | APPROVATO |
| 23 | FUNC-03 residuo | Guard operatività target driver in `piano-giorno/trips`, azione `swap_driver` (riuso helper) | `052e7c9` | `tests/unit/piano-giorno-trips-swap-driver-status-guard.test.ts` (26 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |

Tutti e 23 verificati presenti nel codice reale in questa sessione di riallineamento (grep sui marker chiave: `verifyDriverBelongsToTenant`/`DRIVER_NOT_ACTIVE` in `assign-service.ts`, `VEHICLE_OVERLAP`/`DRIVER_OVERLAP` in `assign-service.ts` e `departure-bus-assign.ts`, `DRIVER_STATUS_FORBIDDEN` in `driver-status.ts`, `verifyTripDriverBelongsToTenant`/`verifyTripServicesOperationalStatus`/`verifyTripDriverIsOperational` in `trips/route.ts` (tutte e tre allargate a `"create_trip" | "update_trip" | "swap_driver"` nelle sessioni 2026-08-04), più esistenza dei 23 file di test dedicati). Sessione di riallineamento puramente read-only: nessun test rieseguito in questa sessione (già verificati verdi nelle sessioni di implementazione precedenti), nessun codice toccato. **Lettura integrale in questa sessione**: `app/api/ops/piano-giorno/trips/route.ts` (le 7 action per intero, con focus mirato su `move_services`/`swap_vehicle`/`delete_trip`/`delay_vessel` — vedi rivalutazione sotto).

## Analisi mirata `piano-giorno/trips` (sessioni 2026-08-03/2026-08-04, lettura integrale del file)

Il file (~1900 righe) implementa 7 action (`create_trip`, `update_trip`, `delete_trip`, `move_services`, `swap_driver`, `swap_vehicle`, `delay_vessel`). SEC-05/FUNC-02/FUNC-03 sono ora chiusi su **`create_trip`, `update_trip` e `swap_driver`** (9 commit, sessioni 2026-08-03/04: `1e10f0c`/`7243e3e`/`0e769d2` per create_trip, `f6492d2`/`c227d26`/`5166c46` per update_trip, `530fd38`/`052e7c9` per SEC-05+FUNC-03 su swap_driver — FUNC-02 non applicabile a swap_driver, vedi sotto).

CONC-02/CONC-03 restano non-gap su tutto il file (invariato dalle sessioni precedenti): `validateVehicleTimelinePayload`/`evaluateDriverTimelineConflicts` sono guard preesistenti reali, non toccati da questa milestone.

**Rivalutazione puntuale per action, sessione odierna** — non si assume che ogni finding valga per ogni action; ricostruito da lettura integrale del codice reale:

| Action | SEC-05 applicabile | FUNC-02 applicabile | FUNC-03 applicabile | Finding reale | Severità | Stato |
|---|---|---|---|---|---|---|
| `create_trip` | Sì | Sì | Sì | — | — | **CHIUSO** (`1e10f0c`/`7243e3e`/`0e769d2`) |
| `update_trip` | Sì | Sì | Sì | — | — | **CHIUSO** (`f6492d2`/`c227d26`/`5166c46`) |
| `swap_driver` | Sì | N/A (nessun `service_ids` nel contratto) | Sì | — | — | **CHIUSO** (`530fd38`/`052e7c9`) |
| `move_services` | **Sì** | **Sì** | **Sì** | `driver_user_id`/`driver_profile_id` (righe 544, 563-564, 579-580, 603-604) scritti su `trip_groups`/`assignments` senza verifica ownership — sia nel ramo "crea nuovo giro" (righe 554-618, client-controlled diretto) sia nel ramo "giro destinazione esistente" quando quel giro non ha ancora un driver (`destGroup?.driver_user_id ?? driver_user_id`, riga 655, fallback sul body). Nessuna chiamata a `verifyTripServicesOperationalStatus`/`verifyTripDriverIsOperational` in tutta l'action | **MEDIUM** (×3, stesso profilo di `create_trip`/`update_trip` prima dei fix) | **APERTO — prossimo task scelto (SEC-05)** |
| `swap_vehicle` | **No** | **No** | **No** | Body reale: `date`, `from_vehicle_label`, `to_vehicle_label` (righe 827-830) — **nessun campo driver, nessun `service_ids`**. Scrive solo `vehicle_label` su `trip_groups`/`assignments` già esistenti, filtrati per tenant. Nessuna delle 3 verifiche è applicabile: non esiste un target driver da validare, non esiste un insieme di servizi da riassegnare | — | **NON APPLICABILE** — nessun fix in questo perimetro |
| `delete_trip` | **No** | **No** | **No** | Body reale: solo `group_id` (tenant-scoped). Nessun driver/servizio client-controlled: libera gli `assignments` esistenti e riporta `services.status="new"` — azione di cleanup/rollback che deve restare **sempre consentita**, indipendentemente da stato driver/servizio | — | **NON APPLICABILE** — per design, non un gap |
| `delay_vessel` | **No** | **Parzialmente, variante distinta** | **No** | Body reale: `date`, `vessel`, `original_time`, `delay_minutes` — **nessun campo driver**. Filtro già presente `.neq("status","cancelled")` (riga 884) ma non esclude `completato`/`needs_review`/`pending_cancellation`/`is_draft`. Micro-gap reale ma **non equivalente** all'helper FUNC-02 esistente (quello blocca la *creazione* di un assignment su servizio non operativo; qui si tratterebbe di bloccare lo *spostamento orario* di un servizio non operativo) — richiederebbe una funzione distinta, non un riuso diretto | **LOW** | **APERTO, non prioritario** — micro-task separato, da valutare solo dopo i finding MEDIUM/HIGH residui |

**Conclusione**: `move_services` è l'unica delle 4 action residue con tutti e 3 i finding realmente aperti, stesso profilo di rischio già chiuso su `create_trip`/`update_trip`/`swap_driver`. `swap_vehicle`/`delete_trip` non hanno alcun finding applicabile di questi 3 tipi (non per omissione, ma perché il loro contratto reale non coinvolge un driver o uno stato servizio scrivibile in quel modo). `delay_vessel` ha solo un micro-gap FUNC-02-variante a bassa severità, non atomico allo stesso modo.

## Rivalutazione finding aperti (sessione 2026-08-04, riallineamento finale post-FUNC-03 su create_trip)

| ID | Titolo | Severità | Stato | Rischio operativo | Dipendenze | Difficoltà | Rischio regressione | Stima tempo | Adatto come prossimo task atomico? |
|---|---|---|---|---|---|---|---|---|---|
| SEC-05 (trips, `create_trip`/`update_trip`/`swap_driver`) | — | MEDIUM | **CHIUSO** (`1e10f0c`, `f6492d2`, `530fd38`) | — | — | — | — | — | — |
| FUNC-02 (trips, `create_trip`/`update_trip`) | — | MEDIUM | **CHIUSO** (`7243e3e`, `c227d26`) | — | — | — | — | — | — |
| FUNC-03 (trips, `create_trip`/`update_trip`/`swap_driver`) | — | MEDIUM | **CHIUSO** (`0e769d2`, `5166c46`, `052e7c9`) | — | — | — | — | — | — |
| SEC-05 (trips, `move_services`) | driver_user_id/driver_profile_id non verificati esplicitamente contro il tenant (ramo nuovo giro + fallback su giro esistente senza driver) | MEDIUM | APERTO — **prossimo task scelto** | Medio: mitigato indirettamente da `driver_daily_availability` (tenant-scoped), ma non è un controllo esplicito | Nessuna diretta | S | Basso (pattern già collaudato 4 volte: `assign-service`, `departure-bus-assign`, `trips create_trip`/`update_trip`/`swap_driver`; helper già generico) | ~1 sessione | **Sì** — perimetro riducibile a una sola action (`move_services`), no migrazione, no UI, rollback singolo commit |
| FUNC-02 (trips, `move_services`) | Nessun guard stato servizio sui service_ids spostati | MEDIUM | APERTO — follow-up dello stesso finding chiuso su `create_trip`/`update_trip` | Medio: stesso rischio già mitigato altrove | Nessuna | S | Basso (denylist e helper già definiti e testati) | ~1 sessione | Sì, dopo SEC-05 sulla stessa action |
| FUNC-03 (trips, `move_services`) | Nessun guard operatività driver | MEDIUM | APERTO — follow-up dello stesso finding chiuso su `create_trip`/`update_trip`/`swap_driver` | Basso-medio: operativo, non sicurezza | Nessuna | S | Basso (helper già scritto, da clonare) | ~1 sessione | Sì, dopo SEC-05/FUNC-02 sulla stessa action |
| SEC-05/FUNC-02/FUNC-03 (trips, `swap_vehicle`) | — | — | — | **Non applicabile**: nessun campo driver né `service_ids` nel contratto reale dell'action (solo `vehicle_label`) | — | **NON UN GAP** | — | — | — |
| SEC-05/FUNC-02/FUNC-03 (trips, `delete_trip`) | — | — | — | **Non applicabile**: nessun driver/servizio client-controlled; azione di cleanup che deve restare sempre consentita | — | **NON UN GAP (per design)** | — | — | — |
| SEC-05/FUNC-03 (trips, `delay_vessel`) | — | — | — | **Non applicabile**: nessun campo driver nel contratto reale | — | **NON UN GAP** | — | — | — |
| FUNC-02-variante (trips, `delay_vessel`) | Filtro stato servizio incompleto (`neq cancelled` ma non esclude completato/needs_review/pending_cancellation/is_draft) sul reschedule orario | LOW | APERTO, non prioritario | Basso: funzionale, non sicurezza; richiede una funzione distinta (non riuso diretto dell'helper FUNC-02, semantica diversa: reschedule vs assegnazione) | Nessuna | S | Basso | ~1 sessione | Sì ma bassa priorità, dopo i MEDIUM residui su `move_services` |
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

**Nessun finding chiuso indirettamente in questa sessione** (puramente read-only): i 23 task completati nelle sessioni precedenti sono stati solo verificati, non modificati. CONC-02/CONC-03 su `trips` restano riclassificati come non-gap (invariato dalla sessione precedente). `swap_vehicle`/`delete_trip` riclassificati in questa sessione come **non applicabili** ai finding SEC-05/FUNC-02/FUNC-03 (non chiusi da un fix — riconosciuti come mai stati un gap reale per quei 3 finding specifici, sulla base della lettura integrale del loro contratto). `delay_vessel` riclassificato come non applicabile a SEC-05/FUNC-03, con un micro-gap FUNC-02-variante a bassa severità individuato ma non equivalente all'helper esistente.

## Top 10 priorità finale M1 (criteri: sicurezza + corruzione dati + falso successo + impossibilità operativa + concorrenza + stato servizio/driver + audit + UX + performance + ML)

1. **SEC-05 residuo** (`trips`, azione `move_services`, MEDIUM) — unico gap di sicurezza/tenant-ownership ancora aperto in questa milestone su `trips`; protezione solo incidentale. Stima S. — **prossimo task scelto**.
2. **FUNC-02 residuo** (`trips`, azione `move_services`, MEDIUM) — denylist già pronta da clonare.
3. **FUNC-03 residuo** (`trips`, azione `move_services`, MEDIUM) — helper già pronto da clonare.
4. **CONC-06** (HIGH ma penalizzato per complessità/rischio regressione) — rivalidazione lock in `auto-assign`, file da 1955 righe, non adatto a "singola sessione a basso rischio" ma severità intrinseca alta.
5. **SEC-03** (rivalutato MEDIUM, rischio residuo ulteriormente ridotto dopo la chiusura di SEC-05 su `create_trip`/`update_trip`/`swap_driver`) — filtro tenant esplicito sul join, difesa in profondità, 2 file.
6. **CONC-07** (MEDIUM) — audit trail mancante su `assign-service`, gap di osservabilità non di sicurezza.
7. **SEC-06** (MEDIUM, multi-file) — sanitizzazione errori Supabase raw, rischio basso (information disclosure schema).
8. **FUNC-02-variante `delay_vessel`** (LOW) — micro-gap su reschedule orario servizi non operativi, richiede funzione distinta, non atomico allo stesso modo dei residui MEDIUM.
9. **M2-\*** (strutturali: EXCLUDE constraint DB, RPC transazionali, lock collaborativo, unificazione scoring) — richiedono design multi-sessione, fuori scope per task atomici singoli.
10. **M1.5-\*** / **M2-05..M2-09** (UX, ML/test/performance residui) — basso costo o bassa urgenza, non bloccanti.

## Decisione Milestone 1 (sessione 2026-08-04, dopo pacchetto update_trip + swap_driver)

**B) Milestone 1 richiede ancora 1 task residuo di categoria sicurezza su `trips`** (`move_services`, che porta con sé anche FUNC-02/FUNC-03 sulla stessa action come follow-up immediati), **più i task strutturali/multi-route già noti (CONC-06, SEC-03, SEC-06, CONC-07) rinviati per motivi espliciti di scope/rischio, non per assenza di rischio**. `swap_vehicle`/`delete_trip`/`delay_vessel` (salvo il micro-gap LOW su quest'ultimo) sono stati riclassificati come non applicabili ai 3 finding SEC-05/FUNC-02/FUNC-03 dopo lettura integrale del loro contratto reale — questo riduce il numero di action ancora da correggere su `trips` da 4 a 1 (`move_services`). Non si dichiara "nessun rischio": CONC-06 (HIGH) resta aperto e rinviato per complessità/dimensione del file.

## Prossimo task scelto: SEC-05 residuo su `piano-giorno/trips`, azione `move_services`

**Motivazione**: tra i candidati confrontati (A: SEC-05 residuo `move_services`: MEDIUM, unico gap di sicurezza reale rimasto su `trips`; B: FUNC-02/FUNC-03 residui sulla stessa action: MEDIUM ma categoria "stato servizio/driver", da chiudere subito dopo come follow-up naturale, priorità #2-3; C: `swap_vehicle`/`delete_trip`/`delay_vessel`: **non applicabili** o LOW, esclusi dalla lettura integrale di questa sessione; D: CONC-02/CONC-03 residui trips: **non un gap reale**, esclusi; E: SEC-03: MEDIUM rivalutato, rischio residuo basso, 2 file — meno atomico di un singolo task su una singola action; F: SEC-06: MEDIUM ma multi-route, esclude il criterio "una sola route"; G: CONC-07: MEDIUM ma categoria "audit", priorità più bassa; H: CONC-06: HIGH ma file da 1955 righe, rischio di regressione troppo alto per una singola sessione a basso rischio), **SEC-05 residuo su `move_services`** è il candidato di categoria sicurezza (priorità #1) più prioritario ancora realmente aperto e atomico: soddisfa tutti i criteri richiesti (1 route, 1 action, nessuna migrazione, nessuna UI, rollback a singolo commit, testabile a livello handler, pattern già collaudato 4 volte — inclusa la stessa route su `create_trip`/`update_trip`/`swap_driver`).

## Perimetro del prossimo task (SEC-05 su `piano-giorno/trips`, action `move_services`) — non implementato

- **Finding**: SEC-05 — `piano-giorno/trips/route.ts`, action `move_services` (righe 543-734), non verifica che `driver_user_id`/`driver_profile_id` ricevuti dal client appartengano al tenant autenticato prima di scrivere `trip_groups`/`assignments`. Il gap si manifesta in due punti: (1) ramo "crea nuovo giro" (righe 554-618, `!destGroupId`), dove `driver_user_id`/`driver_profile_id` del body vengono scritti direttamente nell'`insert` di `trip_groups` (righe 603-604) senza alcuna verifica; (2) ramo "giro destinazione esistente" (riga 655), dove se il gruppo target non ha ancora un driver assegnato (`destGroup?.driver_user_id` null), il codice ricade sul `driver_user_id` del body (`?? driver_user_id`), anch'esso non verificato.
- **Causa**: nessuna query su `memberships`/`driver_profiles` filtrata per tenant prima di nessuna delle due scritture; l'unica protezione è indiretta (via `driver_daily_availability` dentro `validateTripPayload`, chiamato solo quando `destDriver` è truthy).
- **Route/Action**: `app/api/ops/piano-giorno/trips/route.ts`, **solo `move_services`**.
- **File**: `app/api/ops/piano-giorno/trips/route.ts` soltanto. **Nessun nuovo helper da scrivere**: `verifyTripDriverBelongsToTenant()` è già generico, va solo invocato con `action: "move_services"` (allargare il tipo union) sui valori finali del driver effettivamente scritto in ciascun ramo (`driver_user_id`/`driver_profile_id` nel ramo nuovo giro; `destDriver`/`destDriverProfile` nel ramo giro esistente, dopo il calcolo alla riga 655-656).
- **Guard**: due punti di invocazione necessari (uno per ramo), entrambi **prima** delle rispettive scritture (`insert` riga 598 per il nuovo giro; `update` assignments riga 705 per il giro esistente).
- **Status HTTP**: `404 DRIVER_NOT_FOUND` per ownership; `500` fail-closed su errore query (stessi codici di `create_trip`/`update_trip`/`swap_driver`).
- **Test**: nuovo file `tests/unit/piano-giorno-trips-move-services-driver-tenant-guard.test.ts` — driver same-tenant in entrambi i rami (successo), cross-tenant/inesistente/non-driver in entrambi i rami (404), ramo "giro esistente con driver già impostato" (guard non deve bloccare/duplicare, il driver del gruppo esistente prevale), `create_trip`/`update_trip`/`swap_driver`/`delete_trip`/`swap_vehicle`/`delay_vessel` invariate, SEC-02 (già presente sui `service_ids`? verificare in fase di implementazione se manca anche quello, vedi nota sotto) invariato, zero scritture prima del guard.
- **Nota da verificare in fase di implementazione**: la lettura di questa sessione ha rilevato che `move_services` non chiama mai `verifyServiceIdsBelongToTenant` sui `service_ids` in input (SEC-02) — le scritture reali restano comunque tenant-scoped perché sono `UPDATE` filtrate per `tenant_id` su assignment già esistenti (non `INSERT` di nuove righe), quindi non risulta uno sfruttabile diretto noto, ma va confermato esplicitamente all'inizio del prossimo task prima di escluderlo definitivamente dal perimetro.
- **Fail-closed**: sì.
- **Regressioni**: nessuna prevista — task additivo.
- **Rollback**: revert del singolo commit dedicato.
- **Definition of Done**: come da `assignments-hardening-checklist.md`.
- **Commit suggerito**: `fix: verify driver tenant ownership before move_services in piano-giorno trips (SEC-05 residuo)`.

I candidati immediatamente successivi, in ordine: FUNC-02 residuo su `move_services`; FUNC-03 residuo su `move_services`; poi SEC-03 (atomizzato per file), CONC-07, SEC-06, FUNC-02-variante `delay_vessel` (LOW), infine CONC-06 (HIGH, ma richiede una sessione dedicata per il rischio di regressione sul file da 1955 righe).

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

Poi partire dal "Prossimo task scelto" sopra (SEC-05 residuo su `piano-giorno/trips/route.ts`, azione `move_services`), seguendo il Definition of Done della checklist. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
