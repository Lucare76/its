# Checklist hardening — modulo Assegnazioni

Regole operative (stesse del modulo Navette):
- Un task alla volta, atomico, con commit dedicato.
- Ogni task modifica solo ciò che serve a chiudere il finding indicato.
- Test obbligatori per ogni fix comportamentale.
- Nessun task tocca WhatsApp, template, webhook Meta.
- Separazione esplicita tra: bug runtime, hardening, audit-doc, ML validation/safety/quality/architecture.

## Stato Milestone 1 (aggiornato 2026-08-03)

7 task CRITICAL/HIGH completati e pushati su main: M1-01 (SEC-01, `27f5624`), M1-02 (SEC-02, `966f2a5`), M1-03 (CONC-01, `b33ce74`), M1-05 (FUNC-01, `6235acb`), M1-10 (SEC-05, perimetro `assign-service`, `2712d76`), M1-17 (RACE-01, `c44f6d9`) + fix di semantica upsert post-RACE-01 (`983e1a1`, stesso finding, secondo commit dedicato per il reset esplicito dei metadati stale). Tutti con test dedicati verdi (98 test totali sui sei file di test toccati da questi fix, verificati in questa sessione con `pnpm exec vitest run`) e reviewer indipendente APPROVATO.

**Prossimo task scelto**: M1-07 (CONC-03), perimetro ridotto a `app/api/ops/assign-service/route.ts` soltanto (stesso pattern di split-per-route usato per SEC-05). Non ancora implementato — vedi perimetro dettagliato in `docs/plans/assignments-working-status.md`.

Il modulo **non è completo**: restano aperti M1-04, M1-06, M1-07 (CONC-03, prossimo), M1-08, M1-09, M1-11..M1-16 (inclusi FUNC-02/FUNC-03, severità confermata), M1.5-*, M2-*. SEC-05 su `departure-bus-assign`/`trips` e la semantica lock/source restano item di follow-up separati (vedi note sotto).

## Milestone 1 — Alta stagione (bug runtime + hardening critico/alto)

- [x] **M1-01 — SEC-01: tenant guard su `departure-bus-assign`** (bug runtime — CRITICAL) — **COMPLETATO**
  - Verificare `service_ids` appartenenti al tenant prima di `assign_driver`/`remove_driver`.
  - Test: tenant isolation su entrambe le azioni.
  - Stima: S. Rollback: revert singolo commit. Feature flag: non necessario.
  - Dipendenze: nessuna.
  - Commit: `27f5624` — "fix: verify service ownership before departure bus assignments (SEC-01)".
  - Test dedicati: `tests/unit/departure-bus-assign-tenant-isolation.test.ts` (13 casi, verdi).
  - Reviewer: APPROVATO (sessione 2026-08-02).

- [x] **M1-02 — SEC-02: tenant guard su `piano-giorno/trips` (create_trip/update_trip)** (bug runtime — CRITICAL) — **COMPLETATO**
  - `validateTripPayload` deve bloccare se `serviceRows.length !== serviceIds.length`.
  - Test: tenant isolation su create_trip/update_trip con service_id misto.
  - Stima: S. Dipendenze: nessuna (può condividere helper con M1-01, ma non bloccante).
  - Commit: `966f2a5` — "fix: verify service and target-group ownership before trip mutations (SEC-02)".
  - Test dedicati: `tests/unit/piano-giorno-trips-tenant-isolation.test.ts` (verde). Implementato con helper `verifyServiceIdsBelongToTenant` (righe 829-886) riusato in `create_trip`/`update_trip`/`move_services`, incluso guard esplicito su `target_group_id` tenant-scoped.
  - Reviewer: APPROVATO (verificato in questa sessione, 2026-08-02: `delete_trip` invariato, nessun leak cross-tenant residuo sul percorso `create_trip`/`update_trip`/`move_services`).

- [x] **M1-03 — CONC-01: controllo errore insert in `assign-service`** (bug runtime — CRITICAL) — **COMPLETATO**
  - Controllare `.error` dell'insert su `assignments`, rispondere 409 su violazione unique invece di falso `{ok:true}`.
  - Test: race condition simulata (doppio insert concorrente stesso service_id).
  - Stima: XS. Rollback: revert singolo commit.
  - Commit: `b33ce74` — "fix: handle unique constraint violation on concurrent service assignment (CONC-01)".
  - Test dedicati: `tests/unit/assign-service-concurrency.test.ts` (20 casi, verdi). Cleanup `trip_groups` orfano su conflitto (`cleanupCreatedTripGroup`), risposta `SERVICE_ALREADY_ASSIGNED` 409.
  - Reviewer: APPROVATO.

- [ ] **M1-04 — SEC-04: tenant/titolarità guard su `driver-status`** (bug runtime — HIGH)
  - Aggiungere verifica `assignments.driver_user_id/driver_profile_id = utente corrente` quando ruolo = driver.
  - Test: driver non può modificare stato di servizio non suo.
  - Stima: S.

- [x] **M1-05 — FUNC-01 (parziale): riuso validazioni in `departure-bus-assign`** (hardening — CRITICAL/HIGH) — **COMPLETATO**
  - Riusare `validateSingleServiceGeography`/controlli disponibilità già esistenti in `assign-service`.
  - Test: blocco su driver non disponibile/sospeso/servizi sovrapposti.
  - Stima: M. Dipendenze: M1-01 (stessa route).
  - Commit: `6235acb` — "fix: enforce daily availability and driver geographic compatibility on departure bus assignment".
  - Implementato: guard `daily_availability_confirmations` su tutte le date uniche del batch + validazione geografica del batch (trattato come unica finestra operativa, non servizio per servizio) tramite nuovo helper condiviso `validateDriverGeographicBatch` (`lib/server/geo-assignment.ts`), riusato anche da `assign-service` (comportamento di quest'ultimo invariato). Nessuna scrittura prima dei guard.
  - Test dedicati: `tests/unit/departure-bus-assign-operational-validation.test.ts` (19 casi, verdi), inclusi test di sensibilità (bypass manuale del guard → failure reale confermata).
  - Reviewer: APPROVATO (funzionale + indipendente, sessione 2026-08-02).
  - **Nota — parziale per design**: questo task copre solo disponibilità+geografia, come da titolo. Stato servizio (FUNC-02) e sospensione driver (FUNC-03) restano deliberatamente fuori scope, vedi M1-15/M1-16 sotto.

- [ ] **M1-06 — CONC-02: vero controllo overlap orario stesso driver** (hardening — HIGH)
  - Aggiungere check overlap `[start,end)` esplicito, applicato anche quando si usa `driver_profile_id`.
  - Test: due assegnazioni sovrapposte allo stesso driver bloccate/warning.
  - Stima: M.

- [ ] **M1-07 — CONC-03: controllo overlap mezzo in `assign-service`** (hardening — HIGH) — **APERTO, severità confermata/aggravata** — ⭐ **PROSSIMO TASK**
  - Invocare `vehicleIntervalsOverlap`/`findVehicleTimelineConflict` anche qui.
  - Test: due assegnazioni sovrapposte sullo stesso mezzo bloccate.
  - Stima: S → **M** (nessuna funzione condivisa pronta: `trips/route.ts` implementa l'overlap con una funzione locale `validateVehicleTimelinePayload`, non riusa `vehicleIntervalsOverlap` di `lib/piano-vehicle-timeline.ts`; va deciso se riusare quella lib o clonare il pattern locale).
  - **Rivalutato 2026-08-02**: `validateDriverGeographicBatch` introdotto da FUNC-01 valida solo il tempo di trasferimento geografico del **driver**, non l'overlap dello **stesso mezzo** — non è un sostituto. Il gap è ora più visibile perché `piano-giorno/trips` blocca l'overlap mezzo mentre `assign-service`/`departure-bus-assign` (entrambe scritture dirette su `assignments`) no: un operatore può creare via queste due route un doppio impegno mezzo che `trips` avrebbe rifiutato. Severità confermata MEDIUM-HIGH.
  - **Riconfermato invariato 2026-08-03**: SEC-05, RACE-01 e il fix di semantica upsert non toccano overlap mezzo (verificato: nessuna occorrenza di `vehicleIntervalsOverlap`/`findVehicleTimelineConflict` in `assign-service/route.ts` dopo i tre fix). **Perimetro scelto per il prossimo task atomico**: SOLO `app/api/ops/assign-service/route.ts`, stesso pattern di split-per-route usato per SEC-05 (M1-10) — `departure-bus-assign` resta follow-up separato dello stesso finding CONC-03.
  - File coinvolti: `app/api/ops/assign-service/route.ts`, `app/api/ops/departure-bus-assign/route.ts` (nessuno dei due controlla overlap mezzo).

- [ ] **M1-08 — SEC-03: filtro tenant esplicito su join `services!inner`** (hardening — HIGH)
  - Aggiungere `tenant_id` alla select del join, filtro esplicito.
  - Test: nessun dato di altro tenant in messaggi d'errore.
  - Stima: XS.

- [ ] **M1-09 — CONC-06: rivalidazione lock al commit di `auto-assign` regenerate_all** (hardening — HIGH)
  - Rileggere `locked_by_operator` immediatamente prima dell'upsert finale.
  - Test: lock impostato dopo lo snapshot iniziale non viene sovrascritto.
  - Stima: M.

- [x] **M1-10 — SEC-05: validazione tenant driver_user_id/driver_profile_id ovunque** (hardening — MEDIUM → **HIGH**) — **COMPLETATO (perimetro `assign-service` soltanto)**
  - Commit: `2712d76` — "fix: verify driver tenant ownership before manual assignment in assign-service (SEC-05)".
  - Implementato: `verifyDriverBelongsToTenant()` in `assign-service/route.ts`, invocata solo per action `"assign"`, prima di qualunque guard/scrittura successiva (prima del check `daily_availability_confirmations`). Verifica `driver_user_id` contro `memberships` (tenant+role=driver) e `driver_profile_id` contro `driver_profiles` (tenant), più coerenza incrociata user/profile. Risposta `404 DRIVER_NOT_FOUND` identica per: driver inesistente, cross-tenant, coppia user/profile incoerente (non rivela il motivo). Errore di query → `500` fail-closed. FUNC-03 esplicitamente non toccato (commento nel codice).
  - Test dedicati: `tests/unit/assign-service-driver-tenant-guard.test.ts` (nuovo, verde), più aggiornamento di `tests/unit/assign-service-concurrency.test.ts` per il nuovo guard. Verificati in questa sessione con `pnpm exec vitest run` (tutti verdi).
  - Reviewer: APPROVATO (sessione di riallineamento 2026-08-03: verificato che il guard precede ogni scrittura, risposta 404 uniforme, FUNC-03 invariato).
  - **Follow-up separato**: `departure-bus-assign` e `piano-giorno/trips` restano item aperti dello stesso finding SEC-05 (non implementati in questo task, per design — vedi nota storica sopra).
  - Estendere il controllo anche quando manca un veicolo nel payload.
  - Test: assegnazione con driver di altro tenant rifiutata.
  - Stima: S.
  - **Rivalutato in questa sessione (2026-08-02)**: `assign-service/route.ts` e `departure-bus-assign/route.ts` (`assign_driver`) hanno un **gap totale** — nessuna verifica tenant su `driver_user_id`/`driver_profile_id`, in nessuna condizione (l'unico controllo collegato, `validateDriverGeographicBatch`, verifica compatibilità geografica tra gli assignment del tenant, non l'appartenenza del driver al tenant — un driver esterno senza assignment pregressi nel tenant passa senza conflitti). Severità aggiornata **HIGH** per queste due route (era MEDIUM). `piano-giorno/trips` ha invece una protezione solo **incidentale**: un `driver_user_id`/`driver_profile_id` di un altro tenant viene bloccato indirettamente perché non avrà mai un record in `driver_daily_availability` (creato solo tramite `disponibilita/route.ts`, tenant-scoped) — non è un controllo esplicito, resta **MEDIUM**, da rendere esplicito in un secondo momento.
  - Impatto reale confermato: **integrità dati** (assignment con `tenant_id`=A ma `driver_user_id` di un driver B), **non leak diretto** — `driver-data/route.ts` e `sendPushToUser` filtrano comunque per il tenant della sessione del driver, quindi un driver di tenant B non vede né riceve notifiche per il servizio di tenant A (salvo membership multi-tenant, non verificata in questo audit).
  - **Perimetro scelto per il prossimo task atomico**: SOLO `app/api/ops/assign-service/route.ts` (route più piccola — 274 righe, un solo punto di scrittura, gap totale su entrambi i campi, pattern di verifica già pronto da clonare da `verifyServicesBelongToTenant` di `departure-bus-assign`). `departure-bus-assign` e `piano-giorno/trips` restano item di follow-up separati (stesso finding SEC-05, task atomici distinti da aprire dopo, per non mescolare più route in un solo commit).
  - Dipendenze: nessuna. Pattern riusabile già presente in due varianti nel codebase (`verifyServicesBelongToTenant` in `departure-bus-assign`, `verifyServiceIdsBelongToTenant` in `trips`).

- [ ] **M1-11 — SEC-06: sanitizzazione errori Supabase raw** (hardening — MEDIUM)
  - Messaggi generici lato client, log dettagliato server-side, su tutte le route toccate in questo audit.
  - Test: nessun messaggio contiene dettagli Postgres/PostgREST raw.
  - Stima: M (multi-file).

- [ ] **M1-12 — TEST-01: test HTTP-level per `assign-service`/`departure-bus-assign`** (test coverage — HIGH)
  - Happy path, tenant isolation, race condition, driver sospeso.
  - Stima: M.

- [ ] **M1-13 — TEST-03: suite tenant isolation per tutte le route di assegnazione** (test coverage — HIGH)
  - Uniformare con lo stesso pattern usato per shuttle-schedules.
  - Stima: M.

- [ ] **M1-14 — CONC-07: audit trail per `assign-service`** (hardening — MEDIUM)
  - Chiamare `logAssignmentChange` anche da questo endpoint.
  - Test: verifica scrittura `driver_assignment_history` su override manuale.
  - Stima: S.

- [ ] **M1-15 — FUNC-02: blocco assegnazione su servizio già completato/partito/cancellato** (hardening — MEDIUM) — **APERTO, severità confermata**
  - Guardia server-side in `assign-service`/`trips` (create/update/move).
  - Test: tentativo di assegnazione su servizio `cancelled` rifiutato con messaggio chiaro.
  - Stima: S. Rischio: verificare che non rompa flussi legittimi di correzione post-hoc (valutare eccezione per ruolo admin).
  - **Rivalutato in questa sessione (2026-08-02)**: confermato ancora aperto e invariato dai fix SEC-01/SEC-02/CONC-01/FUNC-01. `assign-service` legge `services.status` (riga 81) ma non lo usa mai come guardia (fetched-ma-inutilizzato); `trips`/`departure-bus-assign` non lo selezionano nemmeno. Severità confermata MEDIUM (problema di correttezza dati/UX operativa, non di autorizzazione).

- [ ] **M1-16 — FUNC-03: enforcement `access_suspended` server-side** (hardening — MEDIUM) — **APERTO, severità confermata, indipendente da SEC-05**
  - Aggiungere filtro anche in `assign-service`/`trips` create/update/move/swap.
  - Test: assegnazione a driver sospeso rifiutata dalla route, non solo nascosta in UI.
  - Stima: S.
  - **Rivalutato in questa sessione (2026-08-02)**: confermato ancora aperto. `memberships.suspended` (alias applicativo `access_suspended` in `driver-registry.ts:165`) è filtrato server-side solo in `auto-assign/route.ts:1068`; zero occorrenze in `assign-service`, `trips`, `departure-bus-assign`. Il filtro in `piano-giorno/page.tsx:2357` è puramente cosmetico (client-side, dentro un `useMemo` che alimenta solo il dropdown). Confermato **separabile da SEC-05**: guardie diverse (tenant vs stato sospensione), nessuna sovrapposizione di codice prevista.

- [x] **M1-17 — RACE-01 (emerso durante FUNC-01): DELETE+INSERT non atomico in `departure-bus-assign` (assign_driver)** (bug runtime — MEDIUM/HIGH) — **COMPLETATO**
  - Descrizione: `assign_driver` eseguiva `DELETE` seguito da `INSERT` su `assignments` come due statement separati, senza transazione. Confermato un interleaving concreto in cui il `DELETE` del secondo operatore cancellava silenziosamente la riga appena inserita dal primo, poi il proprio `INSERT` andava a buon fine senza errore: lost update silenzioso, entrambi gli operatori ricevevano 200.
  - Vincolo DB coinvolto: `assignments_service_tenant_unique (service_id, tenant_id)` (`0137_assignments_nullable_driver_unique.sql`).
  - Commit: `c44f6d9` — "fix: replace delete-insert with upsert in departure bus assignment (RACE-01)". `DELETE`+`INSERT` sostituiti con `upsert(..., { onConflict: "service_id,tenant_id", ignoreDuplicates: false })` — un solo statement atomico, zero finestra di race.
  - Test dedicati: `tests/unit/departure-bus-assign-race.test.ts` (nuovo, verde), più aggiornamento di `departure-bus-assign-operational-validation.test.ts`/`departure-bus-assign-tenant-isolation.test.ts` per il nuovo path upsert.
  - Reviewer: APPROVATO (sessione 2026-08-03: verificato upsert atomico, nessun DELETE residuo, `onConflict` corretto, zero lost update nei test di race).
  - **Sotto-task M1-17b — fix semantica UPSERT (emerso durante il review di RACE-01)** — **COMPLETATO**
    - Descrizione: un `upsert` a differenza di `DELETE+INSERT` aggiorna solo le colonne presenti nel payload — i campi omessi (`driver_profile_id`, `group_id`, `assignment_source`, `locked_by_operator`, `assigned_by`, `assigned_at`, `lock_reason`) sarebbero sopravvissuti invariati sulla riga esistente invece di azzerarsi come faceva il vecchio `DELETE+INSERT`.
    - Commit: `983e1a1` — "fix: reset stale assignment metadata in departure bus upsert". Payload esteso con reset esplicito: `driver_profile_id: null`, `group_id: null`, `assignment_source: null`, `locked_by_operator: false`, `lock_reason: null`, più `assigned_by`/`assigned_at` valorizzati con l'attore/istante corrente. Atomicità preservata (stesso singolo statement upsert).
    - Test dedicati: `tests/unit/departure-bus-assign-upsert-semantics.test.ts` (nuovo, verde), aggiornamento `departure-bus-assign-tenant-isolation.test.ts`.
    - Reviewer: APPROVATO (sessione 2026-08-03: verificati tutti i 7 campi elencati nel diff, nessun campo stale residuo, nessuna perdita di atomicità).
  - Stima: XS. Rollback: revert dei due commit dedicati. Nessuna migrazione.
  - Dipendenze: nessuna. File: `app/api/ops/departure-bus-assign/route.ts` (azione `assign_driver`).

## Milestone 1.5 — UX (non bloccanti per produzione, ma a basso costo)

- [ ] **M1.5-01 — UI-02: uniformare conferme distruttive** (UX — MEDIUM)
  - Conferma esplicita anche per rimozione/spostamento singolo servizio da un giro.
  - Stima: S.

- [ ] **M1.5-02 — UI-05: separare visivamente "Sposta" da "Rimuovi"** (UX — MEDIUM)
  - Aumentare distanza/dimensione bottoni per ridurre rischio mis-click.
  - Stima: XS.

- [ ] **M1.5-03 — UI-06: fix accessibilità minori** (UX — LOW)
  - Label associate ai select Driver/Mezzo in dispatch; rimuovere nesting `role="button"` dentro `<button>`.
  - Stima: XS.

## Milestone 2 — Strutturale (richiede design, non una singola sessione)

- [ ] **M2-01 — DB-01/DB-02: EXCLUDE constraint anti-overlap driver/mezzo** (hardening strutturale — HIGH)
  - Richiede prima consolidare la rappresentazione data/ora dei servizi (oggi fino a 3 coppie diverse) e valutare `btree_gist`.
  - Stima: L. Dipendenze: decisione di design su rappresentazione temporale unificata dei servizi.

- [ ] **M2-02 — DB-07: transazioni reali via RPC per scritture multi-tabella** (hardening strutturale — HIGH)
  - RPC Postgres per `assign-service`/`create_trip`/`auto-assign` analoga a `finalize_cancellation_request`.
  - Stima: L.

- [ ] **M2-03 — CONC-04/UI-01: lock collaborativo con TTL** (hardening strutturale — MEDIUM)
  - Banner realtime "in modifica da altro operatore", basato su Supabase Realtime presence.
  - Stima: M/L.

- [ ] **M2-04 — Unificazione dei tre motori di scoring** (architettura — MEDIUM)
  - Consolidare `assignGlobalPlanner`, fallback greedy inline in `auto-assign`, e valutare se recuperare o eliminare `dispatch-driver-scoring.ts`.
  - Stima: L.

- [ ] **M2-05 — ML-01: rimuovere o integrare `lib/dispatch-driver-scoring.ts`** (ML architecture — LOW)
  - Decidere se è codice morto da eliminare o funzionalità da collegare alla vista Dispatch.
  - Stima: S (rimozione) / M (integrazione).

- [ ] **M2-06 — ML-02: feature flag per planner/pattern appresi** (ML safety — LOW)
  - Kill-switch esplicito per disattivare `learned_driver_scores` senza deploy di codice.
  - Stima: S.

- [ ] **M2-07 — TEST-04: test per `learned-patterns.ts`/`assignment-history.ts`** (ML validation — MEDIUM)
  - Copertura soglie cold-start, aggiornamento pattern, estrazione feature.
  - Stima: M.

- [ ] **M2-08 — TEST-02: test HTTP-level per `apply-driver-swap`/`apply-vehicle-binding`/`apply-resolution-suggestion`** (test coverage — MEDIUM)
  - Includere simulazione update concorrente per verificare risposta 409 "stale".
  - Stima: M.

- [ ] **M2-09 — TEST-05: performance query storiche** (performance — MEDIUM)
  - Filtro data su `tenant-data`/`dispatch-data`/`suggestions`; batch update in `patch-vehicles`; SQL aggregation invece di JS in `driver-assignment-history`.
  - Stima: M/L (da progettare insieme, rischio di regressione su viste storiche come per lo shuttle module — vedi M2-15 shuttle per precedente).

- [ ] **M2-10 — DB-03: valutare FK `vehicle_id` su `assignments`** (hardening strutturale — LOW/MEDIUM)
  - Sostituire gradualmente `vehicle_label` testo libero con riferimento relazionale.
  - Stima: L (migrazione dati esistenti).

- [ ] **M2-11 — FUNC-06: uniformare strategia reassign (update in-place vs delete+recreate)** (architettura — LOW)
  - Stima: M.

- [ ] **M2-12 — UI-03: valutare libreria dnd touch-compatibile per `planning/page.tsx`** (UX strutturale — LOW)
  - Stima: M.

## Definition of Done (per ogni task)

1. Fix minimo e mirato al finding indicato, nessuna modifica non richiesta.
2. Test automatico che riproduce lo scenario prima del fix (fallisce) e lo conferma dopo (passa).
3. `pnpm typecheck` e `pnpm lint` puliti.
4. Nessuna modifica a WhatsApp/template/webhook.
5. Commit dedicato con messaggio che referenzia l'ID finding (es. "fix: tenant guard on departure-bus-assign (SEC-01)").
6. Aggiornare `docs/plans/assignments-working-status.md` con il task completato e il prossimo raccomandato.

## Rischio e rollback generali

Ogni task di questa checklist è additivo (aggiunge un controllo/validazione) o corregge una gestione errori — nessuno rimuove funzionalità esistente. Rollback standard: `git revert` del commit dedicato. Nessun task richiede feature flag salvo M2-06 (esplicitamente un kill-switch) e M1-15 (valutare se serve un'eccezione di ruolo, da confermare con l'utente prima dell'implementazione).
