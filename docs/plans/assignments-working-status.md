# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 13 TASK CRITICAL/HIGH/MEDIUM COMPLETATI E PUSHATI, RIALLINEAMENTO ESEGUITO DOPO CONC-02 (2026-08-03)

- **Branch**: main
- **HEAD attuale**: `21a25cb` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-08-03)
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

Tutti e 13 verificati presenti nel codice reale in questa sessione di riallineamento (grep sui marker chiave: `DRIVER_STATUS_FORBIDDEN` in `driver-status/route.ts`, `DRIVER_OVERLAP` in `assign-service/route.ts` [6 occorrenze], più esistenza dei relativi file di test dedicati). Sessione di riallineamento puramente read-only: nessun test rieseguito in questa sessione (già verificati verdi nelle sessioni di implementazione precedenti), nessun codice toccato.

## Rivalutazione finding aperti (sessione 2026-08-03, riallineamento post-CONC-02)

| ID | Titolo | Severità | Stato | Rischio operativo | Dipendenze | Difficoltà | Rischio regressione | Stima tempo | Adatto come prossimo task atomico? |
|---|---|---|---|---|---|---|---|---|---|
| CONC-03 (departure-bus-assign) | Overlap mezzo non controllato in `departure-bus-assign` | HIGH | APERTO — **prossimo task scelto** | Alto: bus di partenza Rete Ischia, volume potenzialmente alto in alta stagione, doppio impegno mezzo non rilevato | Nessuna diretta (pattern collaudato 2 volte: `assign-service` CONC-03 e CONC-02) | S-M (più complesso di CONC-03 su assign-service: `assign_driver` gestisce un batch di `service_ids`, non un singolo servizio) | Basso | ~1 sessione | **Sì** — 1 route, no migrazione, no UI, rollback singolo commit, test handler-level |
| SEC-05 (trips) | driver_user_id/driver_profile_id non verificati esplicitamente contro il tenant in `piano-giorno/trips` | MEDIUM | APERTO — protezione solo incidentale | Medio: mitigato indirettamente da `driver_daily_availability` (tenant-scoped), ma non è un controllo esplicito — un cambio futuro a quella tabella romperebbe silenziosamente la protezione | Nessuna diretta | S | Basso | ~1 sessione | Sì, priorità minore di CONC-03 residuo (già una mitigazione indiretta funzionante) |
| FUNC-02 (trips/departure-bus-assign) | Nessun guard stato servizio nelle altre due route | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service` | Medio: stesso rischio già mitigato su `assign-service`, ora relativamente più visibile come incoerenza tra route | Nessuna | S | Basso (denylist già definita e testata) | ~1 sessione | Sì |
| FUNC-03 (trips/departure-bus-assign) | Nessun guard operatività driver nelle altre due route | MEDIUM | APERTO — follow-up del finding chiuso su `assign-service` | Basso-medio: operativo, non sicurezza | Nessuna | S | Basso (helper già scritto, da clonare) | ~1 sessione | Sì |
| CONC-02 (departure-bus-assign/trips) | Nessun overlap orario driver nelle altre due route | HIGH | APERTO — follow-up del finding chiuso su `assign-service` | Alto in alta stagione: stesso gap del finding appena chiuso, ora replicato su due route non ancora coperte | Nessuna diretta (pattern appena collaudato) | S-M | Basso | ~1 sessione | Sì — candidato forte per la sessione successiva a CONC-03 residuo |
| SEC-03 | Join `services!inner` senza filtro tenant esplicito | HIGH (originale) → **MEDIUM** (rivalutato) | APERTO | Basso-medio: rischio ridotto perché SEC-01/SEC-02/SEC-05 ora impediscono la creazione di `assignments` cross-tenant a monte — questo resta un gap di difesa-in-profondità, non più uno sfruttabile diretto noto | Nessuna | XS | Molto basso | Poche ore | Sì, ma bassa urgenza (rischio residuo, non attivo) |
| CONC-06 | Snapshot `locked_by_operator` non rivalidato al commit in `auto-assign` regenerate_all | HIGH | APERTO | Medio: finestra di race stretta, richiede due operatori attivi in contemporanea sullo stesso giorno | Nessuna | M | **Medio-alto** — `auto-assign/route.ts` è un file da ~2000 righe, area ad alta complessità, rischio di regressione più concreto | Più di 1 sessione probabile | **No** — file grande, fuori dal criterio "singola sessione a basso rischio" |
| SEC-06 | Error leak sistemico (messaggi Supabase raw) | MEDIUM | APERTO | Basso: information disclosure sullo schema, non leak dati cross-tenant | Nessuna | M (multi-file) | Basso | 1-2 sessioni | **No** — tocca più route contemporaneamente, non "una sola route" |
| CONC-07 | `assign-service` non scrive audit trail business-level | MEDIUM | APERTO | Basso: gap di osservabilità, non di sicurezza/integrità | Nessuna | S | Basso | ~1 sessione | Sì, ma priorità bassa (non blocca operatività) |
| M1-08, M1-09, M1-11, M1-14 | (vedi checklist per dettaglio) | vario | APERTO | vario | — | — | — | — | vedi righe sopra (SEC-03=M1-08, CONC-06=M1-09, SEC-06=M1-11, CONC-07=M1-14) |
| TEST-01/TEST-03 | Copertura test HTTP-level/tenant isolation | HIGH (originale) → **LARGAMENTE MITIGATO** | quasi CHIUSO per `assign-service`/`departure-bus-assign` | Basso ora | — | — | — | — | Non è più un task a sé, effetto collaterale dei fix comportamentali |
| Lock/source asimmetria | `locked_by_operator`/`assignment_source` diversi tra route | INFO | **CHIUSO come non-issue** | — | — | — | — | — | — |
| RACE-01 | DELETE+INSERT non atomico | MEDIUM/HIGH | **CHIUSO** | — | — | — | — | — | — |
| SEC-04 | Broken access control orizzontale in `driver-status` | HIGH | **CHIUSO** (`6d66f06`) | — | — | — | — | — | — |
| CONC-02 (assign-service) | Overlap orario stesso driver | HIGH | **CHIUSO** (`21a25cb`, perimetro `assign-service`) | — | — | — | — | — | — |
| DB-01/DB-02/DB-07, ML-01/ML-02, TEST-02/04/05, UI-* | (vedi audit §24) | vario | APERTO, non rivalutati in dettaglio | — | — | — | — | — | No — richiedono design/migrazione o toccano UI/ML, fuori dai criteri di "prossimo task atomico" |

**Nessun finding chiuso indirettamente in questa sessione** (puramente read-only): i 13 task completati nelle sessioni precedenti sono stati solo verificati, non modificati. TEST-01/TEST-03 restano l'unica eccezione — la loro mitigazione è un effetto collaterale reale e verificabile dei fix comportamentali già fatti.

## Top 10 priorità (criteri: sicurezza + corruzione dati + falso successo + impossibilità operativa + concorrenza + stato servizio/driver + audit + UX + performance + ML)

1. **CONC-03 residuo** (HIGH, `departure-bus-assign`) — overlap mezzo, volume operativo alto in alta stagione (bus Rete Ischia). Stima S-M. — **prossimo task scelto**.
2. **CONC-02 residuo** (HIGH, `departure-bus-assign`/`piano-giorno/trips`) — overlap driver, stesso gap appena chiuso su `assign-service`, ora il candidato HIGH più forte subito dopo CONC-03 residuo. Stima S-M.
3. **SEC-05 residuo** (`trips`, MEDIUM) — protezione solo incidentale, fragile a refactoring futuri non correlati.
4. **FUNC-02 residuo** (`trips`/`departure-bus-assign`, MEDIUM) — denylist già pronta da clonare.
5. **FUNC-03 residuo** (`trips`/`departure-bus-assign`, MEDIUM) — helper già pronto da clonare.
6. **CONC-06** (HIGH ma penalizzato per complessità/rischio regressione) — rivalidazione lock in `auto-assign`, file grande, non adatto a "singola sessione a basso rischio" ma severità intrinseca alta.
7. **SEC-03** (rivalutato MEDIUM, rischio residuo basso) — filtro tenant esplicito sul join, difesa in profondità.
8. **CONC-07** (MEDIUM) — audit trail mancante su `assign-service`, gap di osservabilità non di sicurezza.
9. **SEC-06** (MEDIUM, multi-file) — sanitizzazione errori Supabase raw, rischio basso (information disclosure schema).
10. **M2-\*** (strutturali: EXCLUDE constraint DB, RPC transazionali, lock collaborativo, unificazione scoring) — richiedono design multi-sessione, fuori scope per task atomici singoli.

## Prossimo task scelto: M1-07 follow-up — CONC-03 residuo, overlap mezzo su `departure-bus-assign`

**Motivazione**: tra i candidati confrontati (A: SEC-05 residuo trips: MEDIUM; B: CONC-03 residuo departure-bus-assign/trips: HIGH; C: FUNC-02 residuo: MEDIUM; D: FUNC-03 residuo: MEDIUM; E: SEC-03: MEDIUM rivalutato, rischio residuo basso; F: SEC-06: MEDIUM ma multi-route, esclude il criterio "una sola route"; G: CONC-06: HIGH ma file da ~2000 righe, rischio di regressione troppo alto per una singola sessione a basso rischio), **CONC-03 residuo** è l'unico HIGH che soddisfa integralmente tutti i criteri richiesti: tocca una sola route (`app/api/ops/departure-bus-assign/route.ts`), nessuna migrazione, nessuna UI, rollback a singolo commit, testabile a livello handler, pattern già collaudato due volte in questa milestone (CONC-03 e CONC-02 su `assign-service`). Il volume operativo della route (bus di partenza Rete Ischia) rende il rischio concreto in alta stagione.

CONC-02 residuo sulle stesse due route è il candidato immediatamente successivo (stesso schema appena chiuso, stima S-M).

## Perimetro del prossimo task (CONC-03 su `departure-bus-assign`) — non implementato

- **Finding**: CONC-03 — `app/api/ops/departure-bus-assign/route.ts` (azione `assign_driver`) non controlla overlap orario dello stesso mezzo (`vehicle_label`) prima dell'upsert su `assignments`, a differenza di `assign-service` (già corretto).
- **Causa**: nessuna chiamata a una funzione di overlap mezzo prima della scrittura; il controllo esiste solo in `assign-service` (`checkVehicleOverlap`, locale, non esportata) e in `piano-giorno/trips` (`validateVehicleTimelinePayload`, locale).
- **Route**: `app/api/ops/departure-bus-assign/route.ts`, azione `assign_driver` soltanto (`remove_driver`/`create_driver_account` invariate).
- **Differenza chiave rispetto al fix già fatto su `assign-service`**: `assign_driver` accetta un **batch** di `service_ids` con un **singolo** `vehicle_label` per l'intero batch (non un servizio alla volta) — il controllo overlap deve valutare la finestra oraria di ciascun servizio del batch contro gli altri impegni del mezzo, e deve anche considerare eventuali overlap **interni al batch stesso** (due servizi del batch che si sovrappongono tra loro), non solo contro impegni esterni preesistenti.
- **File**: `app/api/ops/departure-bus-assign/route.ts` soltanto. Decisione da prendere in fase di implementazione: clonare localmente il pattern di `checkVehicleOverlap` (coerente con l'approccio già usato per tutti i "residuo" precedenti in questa milestone, che non hanno introdotto astrazioni condivise premature) oppure estrarre un helper comune — non decidere in questa sessione read-only.
- **Query**: `trip_groups` attivi stesso tenant/data/`vehicle_label` (esclusi i gruppi del batch corrente se si tratta di un aggiornamento) → `assignments` in quei gruppi → confronto intervalli con `vehicleIntervalsOverlap`.
- **Status HTTP**: `409` su overlap rilevato.
- **Risposta JSON**: `{ ok:false, error:"VEHICLE_OVERLAP", message:"Il mezzo è già impegnato in un altro servizio nello stesso orario." }` (stesso testo già usato in `assign-service`, per coerenza UX).
- **Test**: nuovo file `tests/unit/departure-bus-assign-vehicle-overlap.test.ts` — mezzo libero, overlap con impegno esterno preesistente, overlap interno al batch, tenant isolation, confini temporali, errore DB fail-closed, `remove_driver`/`create_driver_account` invariati, SEC-01/SEC-05/RACE-01/FUNC-01 invariati.
- **Fail-closed**: sì — errore di query blocca la scrittura (500), non procede in silenzio.
- **Regressioni**: nessuna prevista — task additivo; verificare che non rompa il caso legittimo di riassegnazione dello stesso batch allo stesso mezzo (self-overlap da escludere).
- **Rollback**: revert del singolo commit dedicato.
- **Definition of Done**: come da `assignments-hardening-checklist.md`.
- **Commit suggerito**: `fix: block overlapping vehicle assignment in departure bus assignment (CONC-03 residuo)`.

I candidati immediatamente successivi, in ordine: CONC-02 residuo (overlap driver su `departure-bus-assign`/`trips`), SEC-05/FUNC-02/FUNC-03 residui su `piano-giorno/trips`.

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

Poi partire dal "Prossimo task scelto" sopra (M1-07 follow-up/CONC-03 residuo su `departure-bus-assign/route.ts`), seguendo il Definition of Done della checklist. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
