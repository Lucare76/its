# Checklist hardening — modulo Assegnazioni

Regole operative (stesse del modulo Navette):
- Un task alla volta, atomico, con commit dedicato.
- Ogni task modifica solo ciò che serve a chiudere il finding indicato.
- Test obbligatori per ogni fix comportamentale.
- Nessun task tocca WhatsApp, template, webhook Meta.
- Separazione esplicita tra: bug runtime, hardening, audit-doc, ML validation/safety/quality/architecture.

## Milestone 1 — Alta stagione (bug runtime + hardening critico/alto)

- [ ] **M1-01 — SEC-01: tenant guard su `departure-bus-assign`** (bug runtime — CRITICAL)
  - Verificare `service_ids` appartenenti al tenant prima di `assign_driver`/`remove_driver`.
  - Test: tenant isolation su entrambe le azioni.
  - Stima: S. Rollback: revert singolo commit. Feature flag: non necessario.
  - Dipendenze: nessuna.

- [ ] **M1-02 — SEC-02: tenant guard su `piano-giorno/trips` (create_trip/update_trip)** (bug runtime — CRITICAL)
  - `validateTripPayload` deve bloccare se `serviceRows.length !== serviceIds.length`.
  - Test: tenant isolation su create_trip/update_trip con service_id misto.
  - Stima: S. Dipendenze: nessuna (può condividere helper con M1-01, ma non bloccante).

- [ ] **M1-03 — CONC-01: controllo errore insert in `assign-service`** (bug runtime — CRITICAL)
  - Controllare `.error` dell'insert su `assignments`, rispondere 409 su violazione unique invece di falso `{ok:true}`.
  - Test: race condition simulata (doppio insert concorrente stesso service_id).
  - Stima: XS. Rollback: revert singolo commit.

- [ ] **M1-04 — SEC-04: tenant/titolarità guard su `driver-status`** (bug runtime — HIGH)
  - Aggiungere verifica `assignments.driver_user_id/driver_profile_id = utente corrente` quando ruolo = driver.
  - Test: driver non può modificare stato di servizio non suo.
  - Stima: S.

- [ ] **M1-05 — FUNC-01 (parziale): riuso validazioni in `departure-bus-assign`** (hardening — CRITICAL/HIGH)
  - Riusare `validateSingleServiceGeography`/controlli disponibilità già esistenti in `assign-service`.
  - Test: blocco su driver non disponibile/sospeso/servizi sovrapposti.
  - Stima: M. Dipendenze: M1-01 (stessa route).

- [ ] **M1-06 — CONC-02: vero controllo overlap orario stesso driver** (hardening — HIGH)
  - Aggiungere check overlap `[start,end)` esplicito, applicato anche quando si usa `driver_profile_id`.
  - Test: due assegnazioni sovrapposte allo stesso driver bloccate/warning.
  - Stima: M.

- [ ] **M1-07 — CONC-03: controllo overlap mezzo in `assign-service`** (hardening — HIGH)
  - Invocare `vehicleIntervalsOverlap`/`findVehicleTimelineConflict` anche qui.
  - Test: due assegnazioni sovrapposte sullo stesso mezzo bloccate.
  - Stima: S.

- [ ] **M1-08 — SEC-03: filtro tenant esplicito su join `services!inner`** (hardening — HIGH)
  - Aggiungere `tenant_id` alla select del join, filtro esplicito.
  - Test: nessun dato di altro tenant in messaggi d'errore.
  - Stima: XS.

- [ ] **M1-09 — CONC-06: rivalidazione lock al commit di `auto-assign` regenerate_all** (hardening — HIGH)
  - Rileggere `locked_by_operator` immediatamente prima dell'upsert finale.
  - Test: lock impostato dopo lo snapshot iniziale non viene sovrascritto.
  - Stima: M.

- [ ] **M1-10 — SEC-05: validazione tenant driver_user_id/driver_profile_id ovunque** (hardening — MEDIUM)
  - Estendere il controllo anche quando manca un veicolo nel payload.
  - Test: assegnazione con driver di altro tenant rifiutata.
  - Stima: S.

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

- [ ] **M1-15 — FUNC-02: blocco assegnazione su servizio già completato/partito/cancellato** (hardening — MEDIUM)
  - Guardia server-side in `assign-service`/`trips` (create/update/move).
  - Test: tentativo di assegnazione su servizio `cancelled` rifiutato con messaggio chiaro.
  - Stima: S. Rischio: verificare che non rompa flussi legittimi di correzione post-hoc (valutare eccezione per ruolo admin).

- [ ] **M1-16 — FUNC-03: enforcement `access_suspended` server-side** (hardening — MEDIUM)
  - Aggiungere filtro anche in `assign-service`/`trips` create/update/move/swap.
  - Test: assegnazione a driver sospeso rifiutata dalla route, non solo nascosta in UI.
  - Stima: S.

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
