# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 15 TASK CRITICAL/HIGH/MEDIUM COMPLETATI E PUSHATI, RIALLINEAMENTO ESEGUITO DOPO CONC-02 RESIDUO (2026-08-03)

- **Branch**: main
- **HEAD attuale**: `3d8356a` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-08-03)
- **Worktree**: pulito (`git status --short` vuoto; cartella `exports/` non presente/non tracciata in questa sessione — da ignorare comunque se ricompare, non aprire, non modificare)
- **Data ultimo riallineamento**: 2026-08-03 (sessione read-only, nessun codice/test modificato in questa sessione)

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

Tutti e 15 verificati presenti nel codice reale in questa sessione di riallineamento (grep sui marker chiave: `verifyDriverBelongsToTenant`/`DRIVER_NOT_ACTIVE` in `assign-service.ts`, `VEHICLE_OVERLAP`/`DRIVER_OVERLAP` in `assign-service.ts` e `departure-bus-assign.ts`, `DRIVER_STATUS_FORBIDDEN` in `driver-status.ts`, più esistenza dei 15 file di test dedicati). Sessione di riallineamento puramente read-only: nessun test rieseguito in questa sessione (già verificati verdi nelle sessioni di implementazione precedenti), nessun codice toccato. **Lettura integrale in questa sessione**: `app/api/ops/piano-giorno/trips/route.ts` (analisi mirata, vedi sezione dedicata sotto).

## Analisi mirata `piano-giorno/trips` (sessione 2026-08-03, lettura integrale del file)

Il file (~1700 righe) implementa 7 action (`create_trip`, `update_trip`, `delete_trip`, `move_services`, `swap_driver`, `swap_vehicle`, `delay_vessel`). Rivalutazione dei 5 finding candidati:

| Finding | Gap ancora reale? | Evidenza | Conclusione |
|---|---|---|---|
| CONC-03 (overlap mezzo) | **No** | `validateVehicleTimelinePayload` (righe ~1500+) esegue un vero controllo overlap mezzo con blocco reale su `create_trip`/`update_trip`/`move_services`, preesistente e mai toccato da questa milestone | **Non è un gap** — conferma l'audit originale ("trips" = percorso più validato) |
| CONC-02 (overlap driver) | **No** | `evaluateDriverTimelineConflicts` (righe ~1165+) blocca realmente quando `availableMinutes<=5` tra due servizi consecutivi dello stesso driver, non solo un'euristica di zona | **Non è un gap** — stesso motivo |
| SEC-05 (tenant ownership driver) | **Sì** | `verifyServiceIdsBelongToTenant` (SEC-02) verifica solo l'ownership dei **servizi**, mai quella del `driver_user_id`/`driver_profile_id`; l'unica protezione è indiretta via `validateDriverAvailabilityPayload` → query `driver_daily_availability`/`driver_profiles` tenant-scoped, che silenziosamente non trova righe per un driver di altro tenant — non un controllo esplicito | **Gap confermato**, MEDIUM (stessa valutazione delle sessioni precedenti) |
| FUNC-02 (stato servizio) | **Sì** | Nessuna lettura/uso di `services.status` come guardia in nessuna delle 7 action | **Gap confermato**, MEDIUM |
| FUNC-03 (driver sospeso) | **Sì** | Nessuna verifica `memberships.suspended`/`driver_profiles.active` in nessuna delle 7 action che assegnano un driver | **Gap confermato**, MEDIUM |

**Conclusione**: CONC-02/CONC-03 residui su `trips` sono stati rimossi dalla Top 10 (non sono finding aperti). Restano aperti solo SEC-05/FUNC-02/FUNC-03 su questa route.

## Rivalutazione finding aperti (sessione 2026-08-03, riallineamento post-CONC-02 residuo)

| ID | Titolo | Severità | Stato | Rischio operativo | Dipendenze | Difficoltà | Rischio regressione | Stima tempo | Adatto come prossimo task atomico? |
|---|---|---|---|---|---|---|---|---|---|
| SEC-05 (trips) | driver_user_id/driver_profile_id non verificati esplicitamente contro il tenant in `piano-giorno/trips` | MEDIUM | APERTO — **prossimo task scelto** | Medio: mitigato indirettamente da `driver_daily_availability` (tenant-scoped), ma non è un controllo esplicito — un cambio futuro a quella tabella romperebbe silenziosamente la protezione | Nessuna diretta | S | Basso (pattern già collaudato 2 volte: `assign-service`, `departure-bus-assign`) | ~1 sessione | **Sì** — perimetro riducibile a una sola action (`create_trip`), no migrazione, no UI, rollback singolo commit |
| FUNC-02 (trips/departure-bus-assign) | Nessun guard stato servizio nelle altre due route | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service` | Medio: stesso rischio già mitigato su `assign-service`, ora relativamente più visibile come incoerenza tra route | Nessuna | S | Basso (denylist già definita e testata) | ~1 sessione | Sì |
| FUNC-03 (trips/departure-bus-assign) | Nessun guard operatività driver nelle altre due route | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service` | Basso-medio: operativo, non sicurezza | Nessuna | S | Basso (helper già scritto, da clonare) | ~1 sessione | Sì |
| SEC-03 | Join `services!inner` senza filtro tenant esplicito | HIGH (originale) → **MEDIUM** (rivalutato) | APERTO | Basso-medio: rischio ridotto perché SEC-01/SEC-02/SEC-05 ora impediscono la creazione di `assignments` cross-tenant a monte — questo resta un gap di difesa-in-profondità, non più uno sfruttabile diretto noto | Nessuna | XS | Molto basso | Poche ore | Sì, ma bassa urgenza (rischio residuo, non attivo) |
| CONC-06 | Snapshot `locked_by_operator` non rivalidato al commit in `auto-assign` regenerate_all | HIGH | APERTO | Medio: finestra di race stretta, richiede due operatori attivi in contemporanea sullo stesso giorno | Nessuna | M | **Medio-alto** — `auto-assign/route.ts` è un file da ~2000 righe, area ad alta complessità, rischio di regressione più concreto | Più di 1 sessione probabile | **No** — file grande, fuori dal criterio "singola sessione a basso rischio" |
| SEC-06 | Error leak sistemico (messaggi Supabase raw) | MEDIUM | APERTO | Basso: information disclosure sullo schema, non leak dati cross-tenant | Nessuna | M (multi-file) | Basso | 1-2 sessioni | **No** — tocca più route contemporaneamente, non "una sola route" |
| CONC-07 | `assign-service` non scrive audit trail business-level | MEDIUM | APERTO | Basso: gap di osservabilità, non di sicurezza/integrità | Nessuna | S | Basso | ~1 sessione | Sì, ma priorità bassa (non blocca operatività) |
| M1-08, M1-09, M1-11, M1-14 | (vedi checklist per dettaglio) | vario | APERTO | vario | — | — | — | — | vedi righe sopra (SEC-03=M1-08, CONC-06=M1-09, SEC-06=M1-11, CONC-07=M1-14) |
| TEST-01/TEST-03 | Copertura test HTTP-level/tenant isolation | HIGH (originale) → **LARGAMENTE MITIGATO** | quasi CHIUSO per `assign-service`/`departure-bus-assign` | Basso ora | — | — | — | — | Non è più un task a sé, effetto collaterale dei fix comportamentali |
| Lock/source asimmetria | `locked_by_operator`/`assignment_source` diversi tra route | INFO | **CHIUSO come non-issue** | — | — | — | — | — | — |
| RACE-01 | DELETE+INSERT non atomico | MEDIUM/HIGH | **CHIUSO** | — | — | — | — | — | — |
| SEC-04 | Broken access control orizzontale in `driver-status` | HIGH | **CHIUSO** (`6d66f06`) | — | — | — | — | — | — |
| CONC-02 (assign-service + departure-bus-assign) | Overlap orario stesso driver | HIGH | **CHIUSO su entrambe le route** (`21a25cb`, `3d8356a`) | — | — | — | — | — | — |
| CONC-03 (assign-service + departure-bus-assign) | Overlap mezzo | HIGH | **CHIUSO su entrambe le route** (`3976d4c`, `7c5d081`) | — | — | — | — | — | — |
| CONC-02/CONC-03 (trips) | Overlap driver/mezzo su `piano-giorno/trips` | HIGH (originale) → **NON UN GAP** | **CHIUSO come non-issue** (mai stato un gap: guard preesistenti già reali) | — | — | — | — | — | — vedi analisi mirata sopra |
| DB-01/DB-02/DB-07, ML-01/ML-02, TEST-02/04/05, UI-* | (vedi audit §24) | vario | APERTO, non rivalutati in dettaglio | — | — | — | — | — | No — richiedono design/migrazione o toccano UI/ML, fuori dai criteri di "prossimo task atomico" |

**Nessun finding chiuso indirettamente in questa sessione** (puramente read-only): i 15 task completati nelle sessioni precedenti sono stati solo verificati, non modificati. CONC-02/CONC-03 su `trips` sono stati **riclassificati** (non chiusi da un fix, ma riconosciuti come mai stati un gap reale, sulla base della lettura integrale del file).

## Top 10 priorità (criteri: sicurezza + corruzione dati + falso successo + impossibilità operativa + concorrenza + stato servizio/driver + audit + UX + performance + ML)

1. **SEC-05 residuo** (`trips`, MEDIUM) — unico gap di sicurezza/tenant-ownership ancora aperto in questa milestone; protezione solo incidentale, fragile a refactoring futuri non correlati. Stima S. — **prossimo task scelto**.
2. **FUNC-02 residuo** (`trips`/`departure-bus-assign`, MEDIUM) — denylist già pronta da clonare.
3. **FUNC-03 residuo** (`trips`/`departure-bus-assign`, MEDIUM) — helper già pronto da clonare.
4. **CONC-06** (HIGH ma penalizzato per complessità/rischio regressione) — rivalidazione lock in `auto-assign`, file grande, non adatto a "singola sessione a basso rischio" ma severità intrinseca alta.
5. **SEC-03** (rivalutato MEDIUM, rischio residuo basso) — filtro tenant esplicito sul join, difesa in profondità.
6. **CONC-07** (MEDIUM) — audit trail mancante su `assign-service`, gap di osservabilità non di sicurezza.
7. **SEC-06** (MEDIUM, multi-file) — sanitizzazione errori Supabase raw, rischio basso (information disclosure schema).
8. **M2-\*** (strutturali: EXCLUDE constraint DB, RPC transazionali, lock collaborativo, unificazione scoring) — richiedono design multi-sessione, fuori scope per task atomici singoli.
9. **M1.5-\*** (UX: conferme distruttive, mis-click, accessibilità) — basso costo ma non bloccanti per produzione.
10. **M2-05..M2-09** (ML/test/performance residui) — bassa urgenza operativa.

## Prossimo task scelto: SEC-05 residuo su `piano-giorno/trips`, perimetro ridotto alla sola action `create_trip`

**Motivazione**: tra i candidati confrontati (A: SEC-05 residuo trips: MEDIUM, unico gap di sicurezza reale rimasto; B: FUNC-02 residuo: MEDIUM; C: FUNC-03 residuo: MEDIUM; D: CONC-02 residuo trips: **non un gap reale**, escluso dall'analisi mirata; E: CONC-03 residuo trips: **non un gap reale**, escluso; F: SEC-03: MEDIUM rivalutato, rischio residuo basso; G: SEC-06: MEDIUM ma multi-route, esclude il criterio "una sola route"; H: CONC-06: HIGH ma file da ~2000 righe, rischio di regressione troppo alto per una singola sessione a basso rischio), **SEC-05 residuo** è l'unico candidato di categoria sicurezza (priorità #1 nei criteri richiesti) ancora realmente aperto: soddisfa tutti i criteri richiesti (1 route, 1 action — `create_trip`, la più semplice e più usata —, nessuna migrazione, nessuna UI, rollback a singolo commit, testabile a livello handler, pattern già collaudato 2 volte). FUNC-02/FUNC-03 sono validi candidati immediatamente successivi ma di categoria "stato servizio/driver" (priorità #6, più bassa).

## Perimetro del prossimo task (SEC-05 su `piano-giorno/trips`, action `create_trip`) — non implementato

- **Finding**: SEC-05 — `piano-giorno/trips/route.ts`, action `create_trip`, non verifica che `driver_user_id`/`driver_profile_id` ricevuti dal client appartengano al tenant autenticato prima di scrivere `trip_groups`/`assignments`. `verifyServiceIdsBelongToTenant` copre solo l'ownership dei `service_ids` (SEC-02).
- **Causa**: nessuna query su `memberships`/`driver_profiles` filtrata per tenant prima della scrittura; l'unica protezione è indiretta (righe assenti in `driver_daily_availability` per un driver esterno).
- **Route/Action**: `app/api/ops/piano-giorno/trips/route.ts`, **solo `create_trip`** (perimetro ridotto per atomicità — `update_trip`/`move_services`/`swap_driver` restano follow-up separati dello stesso finding, stesso pattern di split-per-action già usato per split-per-route in questa milestone).
- **File**: `app/api/ops/piano-giorno/trips/route.ts` soltanto. Guard da clonare da `verifyDriverBelongsToTenant()` (identico in `assign-service`/`departure-bus-assign`): query `memberships` (tenant+user_id+role=driver) e `driver_profiles` (tenant+id), stessa risposta 404 uniforme per inesistente/cross-tenant/coppia incoerente.
- **Guard**: helper locale `verifyDriverBelongsToTenant()` (o nome coerente con lo stile del file), invocato dopo `verifyServiceIdsBelongToTenant` (SEC-02) e prima di `validateTripPayload`/scritture.
- **Query**: `memberships.select("user_id").eq("tenant_id",tenantId).eq("user_id",driverUserId).eq("role","driver").maybeSingle()`; `driver_profiles.select("id,user_id").eq("tenant_id",tenantId).eq("id",driverProfileId).maybeSingle()`.
- **Status HTTP**: `404 DRIVER_NOT_FOUND` per ownership; `500 DRIVER_VERIFICATION_FAILED` fail-closed su errore query (stessi codici già usati altrove, per coerenza).
- **Risposta JSON**: `{ ok:false, error:"DRIVER_NOT_FOUND", message:"Autista non trovato." }` / `{ ok:false, error:"DRIVER_VERIFICATION_FAILED", message:"Errore durante la verifica dell'autista." }`.
- **Test**: nuovo file `tests/unit/piano-giorno-trips-driver-tenant-guard.test.ts` — driver same-tenant (successo, invariato), driver cross-tenant/inesistente (404), coppia user/profile incoerente (404), errore query (500 fail-closed), `update_trip`/`move_services`/`delete_trip`/`swap_driver`/`swap_vehicle`/`delay_vessel` invariate, SEC-02/CONC-01(N/A qui)/overlap mezzo-driver preesistenti invariati.
- **Fail-closed**: sì — errore di query blocca la creazione del giro, non procede in silenzio.
- **Regressioni**: nessuna prevista — task additivo; verificare che non rompa il flusso legittimo `create_trip` senza driver (campo opzionale, guard va saltato se assente, come già in `assign-service`).
- **Rollback**: revert del singolo commit dedicato.
- **Definition of Done**: come da `assignments-hardening-checklist.md`.
- **Commit suggerito**: `fix: verify driver tenant ownership in piano-giorno trips create_trip (SEC-05 residuo)`.

I candidati immediatamente successivi, in ordine: FUNC-02 residuo (stato servizio), FUNC-03 residuo (driver sospeso) su `trips`/`departure-bus-assign`; poi SEC-05 sulle action rimanenti di `trips` (`update_trip`, `move_services`, `swap_driver`).

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

Poi partire dal "Prossimo task scelto" sopra (SEC-05 residuo su `piano-giorno/trips/route.ts`, azione `create_trip`), seguendo il Definition of Done della checklist. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
