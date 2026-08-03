# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 11 TASK CRITICAL/HIGH/MEDIUM COMPLETATI E PUSHATI, RIALLINEAMENTO ESEGUITO (2026-08-03, sessione pomeridiana)

- **Branch**: main
- **HEAD attuale**: `e05c43b` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-08-03)
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

Tutti e 11 verificati presenti nel codice reale in questa sessione di riallineamento (grep sui marker chiave: `VEHICLE_OVERLAP`, `SERVICE_NOT_ASSIGNABLE`, `DRIVER_NOT_ACTIVE`, `verifyDriverBelongsToTenant` in `departure-bus-assign`, più esistenza dei 4 nuovi file di test). Sessione di riallineamento puramente read-only: nessun test rieseguito in questa sessione (già verificati verdi nelle sessioni di implementazione precedenti), nessun codice toccato.

## Rivalutazione finding aperti (sessione 2026-08-03, riallineamento pomeridiano)

| ID | Titolo | Severità | Stato | Rischio operativo | Dipendenze | Difficoltà | Rischio regressione | Stima tempo | Adatto come prossimo task atomico? |
|---|---|---|---|---|---|---|---|---|---|
| SEC-04 | Broken access control orizzontale in `driver-status` (driver altera stato servizio non suo) | HIGH | **APERTO** — **prossimo task scelto** | Alto: un driver (anche compromesso) può marcare `completato`/`cancelled`/`problema` il servizio di un collega, inquinando dati operativi e reportistica in tempo reale | Nessuna | S | Basso (guard additivo, pattern già usato 6 volte in questa milestone) | ~1 sessione | **Sì** — 1 route, no migrazione, no UI, rollback singolo commit, test handler-level |
| SEC-05 (trips) | driver_user_id/driver_profile_id non verificati esplicitamente contro il tenant in `piano-giorno/trips` | MEDIUM | APERTO — protezione solo incidentale | Medio: mitigato indirettamente da `driver_daily_availability` (tenant-scoped), ma non è un controllo esplicito — un cambio futuro a quella tabella romperebbe silenziosamente la protezione | Nessuna diretta | S | Basso | ~1 sessione | Sì, ma priorità minore di SEC-04 (già una mitigazione indiretta funzionante) |
| CONC-02 | Nessun vero controllo overlap orario stesso driver (solo euristica geografica) | HIGH | APERTO | Alto in alta stagione: doppie assegnazioni allo stesso driver non rilevate, specie via `driver_profile_id` (controllo assente del tutto) | Nessuna | M | Basso-medio (pattern CONC-03 già collaudato, ma serve gestire sia `driver_user_id` che `driver_profile_id`) | ~1 sessione | Sì — stesso schema di CONC-03, route unica `assign-service` |
| CONC-03 (departure-bus-assign) | Overlap mezzo non controllato in `departure-bus-assign` | HIGH | APERTO — follow-up del finding chiuso su `assign-service` | Alto: bus di partenza Rete Ischia, volume potenzialmente alto in alta stagione | Nessuna diretta (pattern pronto da `assign-service`) | S-M | Basso | ~1 sessione | Sì |
| FUNC-02 (trips/departure-bus-assign) | Nessun guard stato servizio nelle altre due route | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service` | Medio: stesso rischio già mitigato su `assign-service`, ora relativamente più visibile come incoerenza tra route | Nessuna | S | Basso (denylist già definita e testata) | ~1 sessione | Sì |
| FUNC-03 (trips/departure-bus-assign) | Nessun guard operatività driver nelle altre due route | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service` | Basso-medio: operativo, non sicurezza | Nessuna | S | Basso (helper già scritto, da clonare) | ~1 sessione | Sì |
| SEC-03 | Join `services!inner` senza filtro tenant esplicito | HIGH (originale) → **MEDIUM** (rivalutato) | APERTO | Basso-medio: rischio ridotto perché SEC-01/SEC-02/SEC-05 ora impediscono la creazione di `assignments` cross-tenant a monte — questo resta un gap di difesa-in-profondità, non più uno sfruttabile diretto noto | Nessuna | XS | Molto basso | Poche ore | Sì, ma bassa urgenza (rischio residuo, non attivo) |
| CONC-06 | Snapshot `locked_by_operator` non rivalidato al commit in `auto-assign` regenerate_all | HIGH | APERTO | Medio: finestra di race stretta, richiede due operatori attivi in contemporanea sullo stesso giorno | Nessuna | M | **Medio-alto** — `auto-assign/route.ts` è un file da ~2000 righe, area ad alta complessità, rischio di regressione più concreto | Più di 1 sessione probabile | **No** — file grande, fuori dal criterio "singola sessione a basso rischio" |
| SEC-06 | Error leak sistemico (messaggi Supabase raw) | MEDIUM | APERTO | Basso: information disclosure sullo schema, non leak dati cross-tenant | Nessuna | M (multi-file) | Basso | 1-2 sessioni | No — tocca più route contemporaneamente, non "una sola route" |
| CONC-07 | `assign-service` non scrive audit trail business-level | MEDIUM | APERTO | Basso: gap di osservabilità, non di sicurezza/integrità | Nessuna | S | Basso | ~1 sessione | Sì, ma priorità bassa (non blocca operatività) |
| M1-04..M1-16 residui minori (M1-08, M1-09, M1-11, M1-14) | (vedi sopra, dettaglio checklist) | vario | APERTO | vario | — | — | — | — | vedi righe sopra |
| TEST-01/TEST-03 | Copertura test HTTP-level/tenant isolation | HIGH (originale) → **LARGAMENTE MITIGATO** | quasi CHIUSO per `assign-service`/`departure-bus-assign` | Basso ora | — | — | — | — | Non è più un task a sé, effetto collaterale dei fix comportamentali |
| Lock/source asimmetria | `locked_by_operator`/`assignment_source` diversi tra route | INFO | **CHIUSO come non-issue** | — | — | — | — | — | — |
| RACE-01 | DELETE+INSERT non atomico | MEDIUM/HIGH | **CHIUSO** | — | — | — | — | — | — |
| DB-01/DB-02/DB-07, ML-01/ML-02, TEST-02/04/05, UI-* | (vedi audit §24) | vario | APERTO, non rivalutati in dettaglio | — | — | — | — | — | No — richiedono design/migrazione o toccano UI/ML, fuori dai criteri di "prossimo task atomico" |

**Nessun finding chiuso indirettamente in questa sessione** (puramente read-only): gli 11 task completati nelle sessioni precedenti sono stati solo verificati, non modificati. TEST-01/TEST-03 sono l'unica eccezione — la loro mitigazione è un effetto collaterale reale e verificabile dei fix comportamentali già fatti (non richiede più un task dedicato per `assign-service`/`departure-bus-assign`).

## Top 10 priorità (criteri: sicurezza + rischio operativo + facilità di fix)

1. **SEC-04** (HIGH) — broken access control su `driver-status`, unico finding aperto che è un vero problema di sicurezza (privilege escalation orizzontale), non solo integrità dati. Stima S, nessuna dipendenza, rischio regressione basso. — **prossimo task scelto**.
2. **CONC-02** (HIGH) — overlap driver non controllato in `assign-service`, stesso schema di CONC-03 già collaudato. Stima M.
3. **CONC-03 residuo** (HIGH) — overlap mezzo ancora aperto su `departure-bus-assign`, volume operativo alto in alta stagione. Stima S-M.
4. **SEC-05 residuo** (`trips`, MEDIUM) — protezione solo incidentale, fragile a refactoring futuri non correlati.
5. **FUNC-02 residuo** (`trips`/`departure-bus-assign`, MEDIUM) — denylist già pronta da clonare.
6. **FUNC-03 residuo** (`trips`/`departure-bus-assign`, MEDIUM) — helper già pronto da clonare.
7. **CONC-06** (HIGH ma penalizzato per complessità/rischio regressione) — rivalidazione lock in `auto-assign`, file grande, non adatto a "singola sessione a basso rischio" ma severità intrinseca alta.
8. **SEC-03** (rivalutato MEDIUM, rischio residuo basso) — filtro tenant esplicito sul join, difesa in profondità.
9. **CONC-07** (MEDIUM) — audit trail mancante su `assign-service`, gap di osservabilità non di sicurezza.
10. **SEC-06** (MEDIUM, multi-file) — sanitizzazione errori Supabase raw, rischio basso (information disclosure schema).

## Prossimo task scelto: M1-04 — SEC-04, guard titolarità su `driver-status`

**Motivazione**: tra tutti i finding ancora aperti, SEC-04 è l'unico non ancora toccato da nessuno degli 11 fix completati **e** l'unico che rappresenta un vero problema di controllo accessi (un driver autenticato può alterare lo stato — incluso marcarlo `completato`/`cancelled`/`problema` — di un servizio assegnato a un collega, semplicemente conoscendone o indovinandone il `service_id`), non solo un rischio di integrità dati come la maggior parte dei finding residui. Rispetto ai candidati alternativi:
- **CONC-02**/**CONC-03 residuo** sono HIGH ma di categoria "overlap", una classe di rischio più bassa nella gerarchia di priorità usata in questa milestone (cross-tenant/controllo-accessi > perdita dati > overlap).
- **SEC-05/FUNC-02/FUNC-03 residui** sono ripetizioni dello stesso pattern già chiuso su `assign-service`, a rischio/complessità già noti — buoni candidati per le prossime sessioni ma meno urgenti di un broken access control non ancora mitigato affatto.
- **CONC-06** ha severità intrinseca alta ma tocca `auto-assign` (file da ~2000 righe): rischio di regressione più alto, probabilmente non completabile in una singola sessione a basso rischio.

SEC-04 soddisfa tutti i criteri richiesti: tocca una sola route (`app/api/ops/driver-status/route.ts`), nessuna migrazione, nessuna modifica UI, rollback con un solo commit, testabile a livello handler (pattern identico ai guard già scritti per `assign-service`), implementabile in una singola sessione.

## Perimetro del prossimo task (SEC-04 su `driver-status`) — non implementato

- **Finding**: SEC-04 — `app/api/ops/driver-status/route.ts` (POST, cambio stato servizio) ammette il ruolo `driver` ma non verifica che l'`assignments.driver_user_id` (o `driver_profile_id` collegato) corrisponda all'utente chiamante — solo `services.tenant_id` è verificato. L'endpoint GET analogo (`driver-data/route.ts`) applica correttamente questo filtro: il pattern corretto esiste già nel codebase, non è replicato qui.
- **Causa**: nessuna query di titolarità sull'assignment prima dell'update di `services.status`/insert su `status_events`.
- **Route**: `app/api/ops/driver-status/route.ts`, unico endpoint coinvolto.
- **Action**: quando `membership.role === "driver"`, dopo la verifica tenant esistente, verificare che esista un `assignments` con `service_id` = quello richiesto e (`driver_user_id` = utente corrente OPPURE `driver_profile_id` collegato all'utente corrente); se assente, bloccare. Ruoli `admin`/`operator`/`supervisor` restano invariati (nessuna restrizione aggiuntiva, comportamento attuale già corretto per loro).
- **Status HTTP**: coerente con lo stile già usato nel modulo — `403`/`404` da valutare in fase di implementazione (verificare se la route usa già un pattern di risposta per casi simili prima di introdurne uno nuovo).
- **Test**: nuovo file `tests/unit/driver-status-ownership-guard.test.ts` — driver titolare del servizio (successo, invariato), driver non titolare (bloccato), admin/operator/supervisor (invariati, nessuna restrizione), servizio inesistente/cross-tenant (comportamento attuale invariato), errore query (fail-closed).
- **Fail-closed**: sì — errore di query sulla titolarità deve bloccare l'update, non procedere silenziosamente.
- **Regressioni**: nessuna prevista — task additivo; verificare che non rompa il flusso legittimo con `driver_profile_id` (alcuni driver potrebbero non avere `driver_user_id` diretto).
- **Rollback**: revert del singolo commit dedicato.
- **Commit suggerito**: `fix: verify driver owns the service before status update (SEC-04)`.

I candidati immediatamente successivi, in ordine: CONC-02 (overlap driver su `assign-service`), CONC-03 residuo (overlap mezzo su `departure-bus-assign`), SEC-05/FUNC-02/FUNC-03 residui su `piano-giorno/trips`.

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

Poi partire dal "Prossimo task scelto" sopra (M1-04/SEC-04 su `driver-status/route.ts`), seguendo il Definition of Done della checklist. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
