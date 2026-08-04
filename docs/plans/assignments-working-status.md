# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: MILESTONE 1 CHIUSA (2026-08-04) — 26 TASK CRITICAL/HIGH/MEDIUM COMPLETATI E PUSHATI, RISCHI STRUTTURALI RINVIATI A M2

**MILESTONE 1 ASSEGNAZIONI — CHIUSA, RISCHI STRUTTURALI RINVIATI A M2**

- **Branch**: main
- **HEAD attuale**: `4a2f683` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` in questa sessione)
- **Worktree**: pulito (`git status --short` vuoto; cartella `exports/` non presente/non tracciata in questa sessione — da ignorare comunque se ricompare, non aprire, non modificare)
- **Data chiusura M1**: 2026-08-04 (sessione read-only di audit finale, nessun codice/test modificato in questa sessione)
- **Pacchetto `move_services` (ultimo residuo di sicurezza/operatività su `piano-giorno/trips`), verificato in questa sessione**:
  - SEC-05 — `bb92f550bca01da504c5ec9d0d488e30ae14542f` — "fix: verify driver tenant ownership before move_services in piano-giorno trips (SEC-05)" — test `tests/unit/piano-giorno-trips-move-services-driver-tenant-guard.test.ts` (39 casi) — verde, reviewer APPROVATO
  - FUNC-02 — `f30e49eedbd8b15f5055ca71bddad265ebc01088` — "fix: block non-operative service status on move_services in piano-giorno trips (FUNC-02)" — test `tests/unit/piano-giorno-trips-move-services-status-guard.test.ts` (34 casi) — verde, reviewer APPROVATO
  - FUNC-03 — `4a2f68387e624ef3a710094066b207115a14be10` — "fix: block non-operative drivers on move_services in piano-giorno trips (FUNC-03)" — test `tests/unit/piano-giorno-trips-move-services-driver-status-guard.test.ts` (32 casi) — verde, reviewer APPROVATO
  - Tutti e 3 rieseguiti in questa sessione (`pnpm exec vitest run` sui 3 file dedicati): 106/106 verdi. `pnpm typecheck`/`pnpm lint` non rieseguiti in questa sessione (già verdi nelle sessioni di implementazione, nessun codice toccato qui).

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
| 24 | SEC-05 residuo | Tenant ownership driver finale in `piano-giorno/trips`, azione `move_services` (entrambi i rami: nuovo giro + valori finali comuni, riuso helper) | `bb92f55` | `tests/unit/piano-giorno-trips-move-services-driver-tenant-guard.test.ts` (39 casi, nuovo) | APPROVATO |
| 25 | FUNC-02 residuo | Guard stato servizio sui service_ids realmente spostati in `piano-giorno/trips`, azione `move_services` (riuso helper, non l'intero target group) | `f30e49e` | `tests/unit/piano-giorno-trips-move-services-status-guard.test.ts` (34 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |
| 26 | FUNC-03 residuo | Guard operatività driver finale in `piano-giorno/trips`, azione `move_services` (entrambi i rami, riuso helper) | `4a2f683` | `tests/unit/piano-giorno-trips-move-services-driver-status-guard.test.ts` (32 casi, nuovo) | APPROVATO (funzionale/security + indipendente) |

Tutti e 26 verificati presenti nel codice reale in questa sessione di chiusura M1 (grep sui marker chiave: `verifyDriverBelongsToTenant`/`DRIVER_NOT_ACTIVE` in `assign-service.ts`, `VEHICLE_OVERLAP`/`DRIVER_OVERLAP` in `assign-service.ts` e `departure-bus-assign.ts`, `DRIVER_STATUS_FORBIDDEN` in `driver-status.ts`, `verifyTripDriverBelongsToTenant`/`verifyTripServicesOperationalStatus`/`verifyTripDriverIsOperational` in `trips/route.ts` — tutte e tre ora allargate a includere anche `"move_services"` —, più i 3 nuovi file di test dedicati rieseguiti in questa sessione: 106/106 verdi). **Lettura mirata in questa sessione**: branch `move_services` per intero (righe 543-793), ramo `delay_vessel` per intero (righe 959-1023), grep multi-file su `services!inner` (SEC-03), grep multi-file su `error: xErr.message` (SEC-06), grep su `logAssignmentChange` (CONC-07), lettura snapshot/commit `auto-assign/route.ts` (CONC-06).

## Analisi mirata `piano-giorno/trips` (sessioni 2026-08-03/2026-08-04, lettura integrale del file)

Il file (~1900 righe) implementa 7 action (`create_trip`, `update_trip`, `delete_trip`, `move_services`, `swap_driver`, `swap_vehicle`, `delay_vessel`). SEC-05/FUNC-02/FUNC-03 sono ora chiusi su **`create_trip`, `update_trip` e `swap_driver`** (9 commit, sessioni 2026-08-03/04: `1e10f0c`/`7243e3e`/`0e769d2` per create_trip, `f6492d2`/`c227d26`/`5166c46` per update_trip, `530fd38`/`052e7c9` per SEC-05+FUNC-03 su swap_driver — FUNC-02 non applicabile a swap_driver, vedi sotto).

CONC-02/CONC-03 restano non-gap su tutto il file (invariato dalle sessioni precedenti): `validateVehicleTimelinePayload`/`evaluateDriverTimelineConflicts` sono guard preesistenti reali, non toccati da questa milestone.

**Rivalutazione puntuale per action, sessione odierna** — non si assume che ogni finding valga per ogni action; ricostruito da lettura integrale del codice reale:

| Action | SEC-05 applicabile | FUNC-02 applicabile | FUNC-03 applicabile | Finding reale | Severità | Stato |
|---|---|---|---|---|---|---|
| `create_trip` | Sì | Sì | Sì | — | — | **CHIUSO** (`1e10f0c`/`7243e3e`/`0e769d2`) |
| `update_trip` | Sì | Sì | Sì | — | — | **CHIUSO** (`f6492d2`/`c227d26`/`5166c46`) |
| `swap_driver` | Sì | N/A (nessun `service_ids` nel contratto) | Sì | — | — | **CHIUSO** (`530fd38`/`052e7c9`) |
| `move_services` | Sì | Sì | Sì | — | — | **CHIUSO** (`bb92f55`/`f30e49e`/`4a2f683`) |
| `swap_vehicle` | **No** | **No** | **No** | Body reale: `date`, `from_vehicle_label`, `to_vehicle_label` (righe 827-830) — **nessun campo driver, nessun `service_ids`**. Scrive solo `vehicle_label` su `trip_groups`/`assignments` già esistenti, filtrati per tenant. Nessuna delle 3 verifiche è applicabile: non esiste un target driver da validare, non esiste un insieme di servizi da riassegnare | — | **NON APPLICABILE** — nessun fix in questo perimetro |
| `delete_trip` | **No** | **No** | **No** | Body reale: solo `group_id` (tenant-scoped). Nessun driver/servizio client-controlled: libera gli `assignments` esistenti e riporta `services.status="new"` — azione di cleanup/rollback che deve restare **sempre consentita**, indipendentemente da stato driver/servizio | — | **NON APPLICABILE** — per design, non un gap |
| `delay_vessel` | **No** | **Parzialmente, variante distinta** | **No** | Body reale: `date`, `vessel`, `original_time`, `delay_minutes` — **nessun campo driver**. Filtro già presente `.neq("status","cancelled")` (riga 884) ma non esclude `completato`/`needs_review`/`pending_cancellation`/`is_draft`. Micro-gap reale ma **non equivalente** all'helper FUNC-02 esistente (quello blocca la *creazione* di un assignment su servizio non operativo; qui si tratterebbe di bloccare lo *spostamento orario* di un servizio non operativo) — richiederebbe una funzione distinta, non un riuso diretto | **LOW** | **APERTO, non prioritario** — micro-task separato, da valutare solo dopo i finding MEDIUM/HIGH residui |

**Conclusione (aggiornata, chiusura M1)**: SEC-05/FUNC-02/FUNC-03 sono ora **chiusi su tutte le 4 action applicabili** (`create_trip`, `update_trip`, `swap_driver`, `move_services`). `swap_vehicle`/`delete_trip` restano non applicabili per design (contratto reale senza driver/stato servizio scrivibile). `delay_vessel` ha solo il micro-gap FUNC-02-variante LOW, rinviato a M2.

## Rivalutazione finding aperti (sessione 2026-08-04, riallineamento finale post-FUNC-03 su create_trip)

| ID | Titolo | Severità | Stato | Rischio operativo | Dipendenze | Difficoltà | Rischio regressione | Stima tempo | Adatto come prossimo task atomico? |
|---|---|---|---|---|---|---|---|---|---|
| SEC-05 (trips, `create_trip`/`update_trip`/`swap_driver`) | — | MEDIUM | **CHIUSO** (`1e10f0c`, `f6492d2`, `530fd38`) | — | — | — | — | — | — |
| FUNC-02 (trips, `create_trip`/`update_trip`) | — | MEDIUM | **CHIUSO** (`7243e3e`, `c227d26`) | — | — | — | — | — | — |
| FUNC-03 (trips, `create_trip`/`update_trip`/`swap_driver`) | — | MEDIUM | **CHIUSO** (`0e769d2`, `5166c46`, `052e7c9`) | — | — | — | — | — | — |
| SEC-05 (trips, `move_services`) | driver_user_id/driver_profile_id non verificati esplicitamente contro il tenant (ramo nuovo giro + fallback su giro esistente senza driver) | MEDIUM | **CHIUSO** (`bb92f55`) | — | — | — | — | — | — |
| FUNC-02 (trips, `move_services`) | Nessun guard stato servizio sui service_ids spostati | MEDIUM | **CHIUSO** (`f30e49e`) | — | — | — | — | — | — |
| FUNC-03 (trips, `move_services`) | Nessun guard operatività driver | MEDIUM | **CHIUSO** (`4a2f683`) | — | — | — | — | — | — |
| SEC-05/FUNC-02/FUNC-03 (trips, `swap_vehicle`) | — | — | — | **Non applicabile**: nessun campo driver né `service_ids` nel contratto reale dell'action (solo `vehicle_label`) | — | **NON UN GAP** | — | — | — |
| SEC-05/FUNC-02/FUNC-03 (trips, `delete_trip`) | — | — | — | **Non applicabile**: nessun driver/servizio client-controlled; azione di cleanup che deve restare sempre consentita | — | **NON UN GAP (per design)** | — | — | — |
| SEC-05/FUNC-03 (trips, `delay_vessel`) | — | — | — | **Non applicabile**: nessun campo driver nel contratto reale | — | **NON UN GAP** | — | — | — |
| FUNC-02-variante (trips, `delay_vessel`) | Filtro stato servizio incompleto (`neq cancelled` ma non esclude completato/needs_review/pending_cancellation/is_draft) sul reschedule orario | LOW | APERTO, non prioritario | Basso: funzionale, non sicurezza; richiede una funzione distinta (non riuso diretto dell'helper FUNC-02, semantica diversa: reschedule vs assegnazione) | Nessuna | S | Basso | ~1 sessione | Sì ma bassa priorità, dopo i MEDIUM residui su `move_services` |
| SEC-03 | Join `services!inner` senza filtro tenant esplicito | HIGH (originale) → **MEDIUM** (rivalutato) | APERTO — **riclassificato M2** in questa sessione: rischio ulteriormente ridotto ora che SEC-05 è chiuso su tutte le action di `trips` incluso `move_services` | Basso-medio: rischio ridotto perché SEC-01/SEC-02/SEC-05 ora impediscono la creazione di `assignments` cross-tenant a monte su tutte le route/azioni — questo resta un gap di difesa-in-profondità, non uno sfruttabile diretto noto | Nessuna | XS per file, tocca 2 file (`assign-service.ts`, `trips.ts`) | Molto basso | Poche ore per file | **M2** — da chiudere insieme a SEC-06 (stessa categoria "error/response hardening") |
| CONC-06 | Snapshot `locked_by_operator` non rivalidato al commit in `auto-assign` regenerate_all | HIGH | APERTO — **riclassificato M2**, riconfermato con lettura diretta in questa sessione (righe ~1094-1101 snapshot, ~1830-1878 upsert finale): nessuna rilettura di `locked_by_operator` immediatamente prima della scrittura, gap invariato | Medio: finestra di race stretta, richiede due operatori attivi in contemporanea sullo stesso giorno (scenario alta stagione) | Nessuna | M | **Medio-alto** — `auto-assign/route.ts` è un file da 1955 righe, area ad alta complessità, rischio di regressione concreto | Più di 1 sessione probabile | **M2 — prossimo macro-step raccomandato** (unico rischio HIGH residuo con impatto concreto noto) |
| SEC-06 | Error leak sistemico (messaggi Supabase raw) | MEDIUM | APERTO — **riclassificato M2**, rivalutato con grep su tutto `app/api/ops/` in questa sessione: gap **sistemico**, non confinato al modulo Assegnazioni — coinvolge decine di route non correlate (`whatsapp-inbox`, `fuel-entries`, `report-jobs`, `driver-file-import`, `bulk-delete-services`, ecc., oltre a `trips.ts`/`patch-vehicles.ts` nel modulo) | Basso: information disclosure sullo schema/DB, non leak dati cross-tenant | Nessuna | L (decine di file, non solo il modulo Assegnazioni) | Basso | Multi-sessione | **M2** — richiede strategia centralizzata (es. wrapper errori generico), non un fix per-file |
| CONC-07 | `assign-service`/`departure-bus-assign` non scrivono audit trail business-level | MEDIUM | APERTO — **riclassificato M2**, confermato con grep in questa sessione: zero occorrenze di `logAssignmentChange` in **entrambe** le route (gap più esteso di quanto documentato: non solo `assign-service`) | Basso: gap di osservabilità, non di sicurezza/integrità | Nessuna | S | Basso | ~1 sessione | **M2** — priorità bassa, task isolato e piccolo quando si riprende il modulo |
| M1-08, M1-09, M1-11, M1-14 | (vedi checklist per dettaglio) | vario | APERTO — tutti riclassificati M2 in questa sessione | vario | — | — | — | — | vedi righe sopra (SEC-03=M1-08, CONC-06=M1-09, SEC-06=M1-11, CONC-07=M1-14) |
| TEST-01/TEST-03 | Copertura test HTTP-level/tenant isolation | HIGH (originale) → **LARGAMENTE MITIGATO** | quasi CHIUSO per `assign-service`/`departure-bus-assign` | Basso ora | — | — | — | — | Non è più un task a sé, effetto collaterale dei fix comportamentali |
| Lock/source asimmetria | `locked_by_operator`/`assignment_source` diversi tra route | INFO | **CHIUSO come non-issue** | — | — | — | — | — | — |
| RACE-01 | DELETE+INSERT non atomico | MEDIUM/HIGH | **CHIUSO** | — | — | — | — | — | — |
| SEC-04 | Broken access control orizzontale in `driver-status` | HIGH | **CHIUSO** (`6d66f06`) | — | — | — | — | — | — |
| CONC-02 (assign-service + departure-bus-assign) | Overlap orario stesso driver | HIGH | **CHIUSO su entrambe le route** (`21a25cb`, `3d8356a`) | — | — | — | — | — | — |
| CONC-03 (assign-service + departure-bus-assign) | Overlap mezzo | HIGH | **CHIUSO su entrambe le route** (`3976d4c`, `7c5d081`) | — | — | — | — | — | — |
| CONC-02/CONC-03 (trips) | Overlap driver/mezzo su `piano-giorno/trips` | HIGH (originale) → **NON UN GAP** | **CHIUSO come non-issue** (mai stato un gap: guard preesistenti già reali) | — | — | — | — | — | — vedi analisi mirata sopra |
| DB-01/DB-02/DB-07, ML-01/ML-02, TEST-02/04/05, UI-* | (vedi audit §24) | vario | APERTO, non rivalutati in dettaglio | — | — | — | — | — | No — richiedono design/migrazione o toccano UI/ML, fuori dai criteri di "prossimo task atomico" |

**Nessun finding chiuso indirettamente in questa sessione** (puramente read-only): i 23 task completati nelle sessioni precedenti sono stati solo verificati, non modificati. CONC-02/CONC-03 su `trips` restano riclassificati come non-gap (invariato dalla sessione precedente). `swap_vehicle`/`delete_trip` riclassificati in questa sessione come **non applicabili** ai finding SEC-05/FUNC-02/FUNC-03 (non chiusi da un fix — riconosciuti come mai stati un gap reale per quei 3 finding specifici, sulla base della lettura integrale del loro contratto). `delay_vessel` riclassificato come non applicabile a SEC-05/FUNC-03, con un micro-gap FUNC-02-variante a bassa severità individuato ma non equivalente all'helper esistente.

## Top priorità M2 (dopo chiusura M1, criteri: sicurezza + corruzione dati + falso successo + impossibilità operativa + concorrenza + stato servizio/driver + audit + UX + performance + ML)

Tutti i finding CRITICAL/HIGH/MEDIUM atomizzabili "1 route, basso rischio" sono chiusi. Ordine raccomandato per l'apertura di M2:

1. **CONC-06** (HIGH) — rivalidazione lock in `auto-assign` regenerate_all, file da 1955 righe. Unico rischio HIGH residuo con impatto concreto noto (race condition su lock operatore in alta stagione). **Prossimo macro-step raccomandato.**
2. **SEC-06 + SEC-03** (MEDIUM, da fare insieme — stessa categoria "error/response hardening") — SEC-06 è sistemico (decine di file in tutta la codebase), SEC-03 è difesa in profondità su 2 file del modulo Assegnazioni.
3. **CONC-07** (MEDIUM) — audit trail mancante su `assign-service`/`departure-bus-assign`, gap di osservabilità non di sicurezza, task piccolo e isolato.
4. **FUNC-02-variante `delay_vessel`** (LOW) — micro-gap su reschedule orario servizi non operativi, richiede funzione distinta, priorità più bassa.
5. **M2-01..M2-12** (strutturali: EXCLUDE constraint DB, RPC transazionali, lock collaborativo, unificazione scoring, ecc.) — richiedono design multi-sessione, fuori scope per task atomici singoli.
6. **M1.5-\*** (UX) — basso costo, non bloccanti, indipendenti dall'ordine sopra.

## Decisione Milestone 1 (sessione 2026-08-04, chiusura finale dopo pacchetto move_services)

**A) Milestone 1 CHIUSA**, rischi strutturali rinviati esplicitamente a M2. Con la chiusura di SEC-05/FUNC-02/FUNC-03 su `move_services` (ultimo residuo aperto della categoria sicurezza/operatività su `piano-giorno/trips`), **tutti** i finding CRITICAL/HIGH/MEDIUM di tipo "bug runtime sfruttabile" o "hardening critico/alto atomizzabile a una route" definiti nell'ambito M1 sono chiusi, testati e con reviewer APPROVATO. I 4 finding rimasti aperti (SEC-03, SEC-06, CONC-07, CONC-06) sono stati riverificati sul codice reale in questa sessione (non solo sulla documentazione precedente) e **nessuno** di essi è, oggi, uno sfruttabile diretto o un bug di correttezza attivo:

- **SEC-03** — difesa in profondità: gli `assignments` con `services!inner` non filtrato esplicitamente per tenant sono, nella pratica, sempre tenant-coerenti perché SEC-01/SEC-02/SEC-05 (ora chiusi su tutte le route/azioni rilevanti, incluso `move_services`) impediscono a monte la creazione di `assignments` cross-tenant. Nessuno sfruttabile diretto noto oggi.
- **SEC-06** — rivalutato in questa sessione con grep su tutto `app/api/ops/`: il leak di messaggi Supabase raw (`error: xErr.message`) non è confinato a 2-3 file del modulo Assegnazioni ma attraversa **decine di route non correlate** (`whatsapp-inbox`, `fuel-entries`, `report-jobs`, `driver-file-import`, `bulk-delete-services`, ecc.). È un finding sistemico cross-cutting dell'intera codebase, non un task atomizzabile "1 route" del modulo Assegnazioni — resta MEDIUM, information disclosure di dettagli schema/DB, mai leak di dati cross-tenant.
- **CONC-07** — confermato con grep mirato: zero occorrenze di `logAssignmentChange` sia in `assign-service/route.ts` sia in `departure-bus-assign/route.ts` (gap più esteso di quanto documentato in precedenza, che citava solo `assign-service`). È un gap di **osservabilità/audit trail**, non di sicurezza o integrità dati: un override manuale del driver via queste due route non lascia traccia in `driver_assignment_history`, ma la scrittura stessa (`assignments`/`trip_groups`) è corretta e tenant-scoped.
- **CONC-06** — confermato con lettura diretta di `auto-assign/route.ts` (1955 righe): lo snapshot di `locked_by_operator` (righe ~1094-1101) viene letto una sola volta a inizio handler ed è lo stesso snapshot usato sia per il `DELETE` selettivo (~riga 1142-1148) sia, molto più sotto, per gli `upsert` finali (~riga 1830-1878) — nessuna rilettura immediatamente prima della scrittura. È l'unico dei 4 residui con un **impatto reale concreto** (finestra di race che permette a `regenerate_all` di sovrascrivere un lock impostato da un operatore dopo lo snapshot iniziale), severità **HIGH** confermata invariata. Il fix richiede una rilettura atomica (idealmente RPC/transazione) immediatamente prima di ogni scrittura, su un file strutturalmente complesso (1955 righe, più modalità `mode`) — rischio di regressione troppo alto per una sessione atomica a basso rischio come richiesto dal Definition of Done di M1. Rinviato esplicitamente a M2, **non per assenza di rischio**.

`delay_vessel` — riletto integralmente in questa sessione (righe 959-1023 del file `trips/route.ts` post-pacchetto): confermato invariato rispetto alla rivalutazione precedente. Nessun campo driver/mezzo nel contratto (`date`, `vessel`, `original_time`, `delay_minutes`), tenant isolation intatta su tutte e 3 le query (`services`/`assignments`/`trip_groups`, tutte `.eq("tenant_id", tenantId)`), zero `driver_user_id`/`driver_profile_id` scritti. Il filtro stato servizio (`.neq("status", "cancelled")`, riga 974) esclude solo `cancelled`, non `completato`/`needs_review`/`pending_cancellation`/`is_draft` — un servizio già completato o in draft potrebbe avere il proprio `time` riprogrammato dal reschedule via ritardo nave. Applicare l'helper FUNC-02 esistente non è un riuso diretto (semantica diversa: qui non si crea un assignment, si aggiorna solo `services.time`), richiederebbe una funzione distinta. **Rischio concreto basso**: non tocca driver/mezzo/assegnazione, è un problema di correttezza dati minore (un orario visualizzato su un servizio storico), non un problema di sicurezza. Un fix sarebbe utile come pulizia dati ma non necessario per la produzione — resta LOW, non bloccante, rinviato a M2 insieme agli altri.

**Non si dichiara "nessun rischio"**: CONC-06 (HIGH) resta un rischio concreto e noto, rinviato a M2 per motivi espliciti di dimensione/complessità del file e non per assenza di impatto. SEC-06 resta un gap sistemico di information disclosure su tutta la codebase. SEC-03 e CONC-07 sono a rischio residuo basso ma non nullo (difesa in profondità nel primo caso, osservabilità nel secondo).

## Nessun task M1 residuo

Con la chiusura del pacchetto `move_services`, **non resta alcun task M1** da eseguire secondo i criteri "1 route, atomico, basso rischio di regressione, testabile a livello handler" che hanno guidato questa milestone. I 4 finding aperti restanti sono stati valutati e classificati esplicitamente come **M2**:

- **CONC-06** (HIGH, `auto-assign/route.ts`) — richiede design dedicato (rilettura atomica pre-scrittura, possibile RPC/transazione), sessione dedicata per il rischio di regressione su un file da 1955 righe. **Prossimo macro-step raccomandato per M2.**
- **SEC-06** (MEDIUM, sistemico multi-route su tutta la codebase) — richiede una strategia di sanitizzazione centralizzata (es. wrapper `dbErrorResponse` generico), non un fix per-file.
- **SEC-03** (MEDIUM, difesa in profondità, 2 file) — basso rischio ma da chiudere quando si affronta SEC-06 nello stesso giro (stessa categoria "error/response hardening").
- **CONC-07** (MEDIUM, audit trail mancante su `assign-service`/`departure-bus-assign`) — basso rischio, priorità più bassa, da chiudere come task singolo quando si riprende il modulo.
- **FUNC-02-variante `delay_vessel`** (LOW) — micro-fix opzionale, priorità più bassa di tutti.

**Prossimo macro-step raccomandato**: CONC-06 (hardening strutturale su `auto-assign/route.ts`) come apertura di M2, essendo l'unico rischio HIGH residuo con impatto concreto noto (race condition su lock operatore in alta stagione). In alternativa, se si preferisce partire da task più piccoli e a basso rischio prima di affrontare il file da 1955 righe: SEC-06/SEC-03 (stessa categoria "error hardening", da fare insieme) o CONC-07 (audit trail, isolato e piccolo).

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

**Milestone 1 è chiusa.** Il prossimo macro-step è **M2 — CONC-06** (rivalidazione lock in `auto-assign/route.ts` regenerate_all), da trattare come sessione dedicata per via della dimensione/complessità del file (1955 righe). In alternativa, per un task più piccolo e a basso rischio prima di affrontare CONC-06: SEC-06+SEC-03 (error/response hardening) o CONC-07 (audit trail `assign-service`/`departure-bus-assign`) — vedi "Top priorità M2" sopra. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
