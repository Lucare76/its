# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 7 TASK CRITICAL/HIGH COMPLETATI E PUSHATI, RIALLINEAMENTO ESEGUITO (2026-08-03)

- **Branch**: main
- **HEAD attuale**: `983e1a1` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-08-03)
- **Worktree**: pulito (`git status --short` vuoto; cartella `exports/` non presente/non tracciata in questa sessione — da ignorare comunque se ricompare, non aprire, non modificare)
- **Data ultimo riallineamento**: 2026-08-03

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

Tutti e sette verificati presenti nel codice reale in questa sessione di riallineamento (diff dei commit letti riga per riga, non solo dal log). Test eseguiti in questa sessione: `pnpm exec vitest run` sui 6 file toccati dai tre fix più recenti (SEC-05/RACE-01/semantica upsert) → **98 test, tutti verdi**. Nessuna regressione riscontrata sui file toccati.

## Rivalutazione finding aperti (sessione 2026-08-03)

| ID | Titolo | Severità originale | Severità aggiornata | Stato | Evidenza |
|---|---|---|---|---|---|
| SEC-05 | driver_user_id/driver_profile_id non verificati contro il tenant | MEDIUM | HIGH (assign-service) / MEDIUM (departure-bus-assign, trips) | **PARZIALMENTE MITIGATO** — chiuso su `assign-service` (`2712d76`), APERTO su `departure-bus-assign`/`trips` | Gap totale ancora presente in `departure-bus-assign` (`assign_driver` non chiama alcun equivalente di `verifyDriverBelongsToTenant`); `trips` protetto solo indirettamente da un side-effect di `driver_daily_availability` |
| RACE-01 | DELETE+INSERT non atomico in `departure-bus-assign` (assign_driver) | — (non presente nell'audit originale) | MEDIUM/HIGH | **CHIUSO** | Upsert atomico (`c44f6d9`) + reset esplicito metadati stale (`983e1a1`); test di race verdi, zero lost update riprodotto |
| CONC-03 | Nessun controllo overlap mezzo in assign-service/departure-bus-assign | HIGH | HIGH (confermata, invariata) | APERTO — **prossimo task scelto** | Verificato in questa sessione: nessuna occorrenza di `vehicleIntervalsOverlap`/`findVehicleTimelineConflict` in `assign-service/route.ts` dopo i tre fix più recenti; SEC-05/RACE-01 non toccano questo path. Incoerenza con `trips` (che blocca) invariata |
| FUNC-02 | Nessun controllo stato servizio prima dell'assegnazione | MEDIUM | MEDIUM (confermata) | APERTO | `services.status` letto ma mai usato come guardia in nessuna delle tre route; SEC-05 aggiunge un guard su driver, non su stato servizio — nessuna sovrapposizione |
| FUNC-03 | `access_suspended`/`memberships.suspended` non enforced server-side nelle scritture manuali | MEDIUM | MEDIUM (confermata) | APERTO — separabile da SEC-05 | Zero occorrenze di `suspended` in assign-service/trips/departure-bus-assign anche dopo i tre fix; filtro esistente solo in `auto-assign` e lato UI (cosmetic) |
| Lock/source (`assign-service` vs `departure-bus-assign`) | Asimmetria `locked_by_operator`/`assignment_source` tra route | — (non finding formale nell'audit originale) | INFO/basso — comportamento ora **intenzionale e documentato** | **CHIUSO come non-issue** (vedi FASE 7) | `departure-bus-assign` scrive esplicitamente `locked_by_operator:false`/`assignment_source:null` in `983e1a1`, per replicare fedelmente il comportamento storico pre-RACE-01 (non introduce un nuovo default); `assign-service` scrive `true`/`"manual_assign_service"`. Asimmetria confermata voluta, non un residuo di RACE-01 — nessun rischio di sovrascrittura auto-assign aggiuntivo rilevato, resta comunque un gap di design (bus di partenza mai marcati come "lock manuale") da valutare in un secondo momento se emergerà un caso operativo concreto |
| SEC-03, SEC-04, SEC-06, CONC-02, CONC-06, CONC-07, DB-01..DB-07, TEST-*, UI-*, ML-01, ML-02 | (vedi audit §24) | — | APERTO, non rivalutati in dettaglio in questa sessione | Nessuno di questi è stato toccato dai tre fix più recenti; nessuna evidenza di mitigazione indiretta trovata |

**Nessun finding è stato chiuso indirettamente dai tre fix più recenti oltre a SEC-05 (parziale) e RACE-01 (completo).** CONC-03/FUNC-02/FUNC-03 restano invariati e indipendenti dal codice toccato da SEC-05/RACE-01/semantica-upsert (nessuna sovrapposizione di file o funzione verificata).

## Top 5 priorità (criteri: cross-tenant > perdita/corruzione dati > falsa conferma > servizio ineseguibile > driver sospeso > overlap > audit > UX > performance > refactoring > ML)

1. **CONC-03** (HIGH) — overlap mezzo non controllato in `assign-service`/`departure-bus-assign`. Probabilità: media. Impatto: doppio impegno mezzo non rilevato, incoerente con `trips` che lo blocca. Stima: M (per `assign-service` da solo). Dipendenze: nessuna diretta. Rischio alta stagione: alto — **prossimo task scelto**.
2. **SEC-05 residuo** (MEDIUM su `departure-bus-assign`/`trips`) — cross-tenant driver ownership non ancora coperto sulle due route rimanenti. Probabilità: alta. Impatto: integrità dati. Stima: S per route. Rischio alta stagione: medio-alto (segue la mitigazione già ottenuta su `assign-service`).
3. **FUNC-02** (MEDIUM) — assegnazione su servizio in stato non valido. Probabilità: bassa-media. Impatto: dati/reportistica inquinati, notifiche spurie. Stima: S. Rischio alta stagione: medio.
4. **FUNC-03** (MEDIUM) — driver sospeso assegnabile via API diretta. Probabilità: bassa. Impatto: operativo, non sicurezza. Stima: S. Rischio alta stagione: medio.
5. **SEC-06** (MEDIUM, non rivalutato in dettaglio) — error leak sistemico messaggi Supabase raw, multi-file. Stima: M. Rischio alta stagione: basso-medio (information disclosure, non integrità dati).

## Prossimo task scelto: M1-07 — CONC-03, perimetro ridotto a `assign-service/route.ts`

**Motivazione**: tra i candidati residui (CONC-03, FUNC-02, FUNC-03, lock/source, SEC-06/audit), CONC-03 è l'unico classificato HIGH, con il rischio operativo più concreto in alta stagione (doppio impegno mezzo non rilevato su una route ad alto volume), nessuna migrazione richiesta (la logica di overlap esiste già in `lib/piano-vehicle-timeline.ts`/pattern locale di `trips/route.ts`, va solo riusata o clonata), nessuna modifica UI, rollback a singolo commit, testabile a livello handler con lo stesso schema già usato per SEC-01/SEC-02/SEC-05. Il perimetro è ridotto alla sola route `assign-service/route.ts` (stesso pattern di split-per-route già usato per SEC-05), per restare un task atomico a un solo finding; `departure-bus-assign` resta follow-up separato dello stesso finding CONC-03.

Il completamento di SEC-05 su `departure-bus-assign` è il candidato immediatamente successivo (pattern già pronto da clonare da `assign-service`, stima S), consigliato come secondo task.

## Perimetro del prossimo task (CONC-03 su `assign-service`) — non implementato

- **Finding**: CONC-03 — nessun controllo di sovrapposizione oraria per lo stesso mezzo (`vehicle_label`) in `assign-service`.
- **Causa**: `assign-service/route.ts` non invoca mai una funzione di overlap mezzo prima dell'insert/update su `assignments`; il controllo esiste solo dentro `piano-giorno/trips` (`validateVehicleTimelinePayload`, locale) e nel planner automatico (`vehicleIntervalsOverlap` in `lib/piano-vehicle-timeline.ts`).
- **Route**: `app/api/ops/assign-service/route.ts`, azione `"assign"` soltanto (azione `"remove"` non scrive nuovi impegni mezzo).
- **Action**: dopo la verifica ownership driver (SEC-05, già presente) e prima dell'insert/upsert finale su `assignments`, se il payload include un `vehicle_label` risolto, interrogare gli altri `assignments` dello stesso tenant/`vehicle_label`/data con orario del servizio sovrapposto; bloccare con 409 se trovato un conflitto reale (non euristico).
- **File**: `app/api/ops/assign-service/route.ts` (unico file applicativo da toccare); eventualmente riesporre/riusare `lib/piano-vehicle-timeline.ts` (`vehicleIntervalsOverlap`) invece di duplicare la logica locale di `trips/route.ts` — decisione da prendere in fase di implementazione, non in questa sessione.
- **Helper**: valutare se estrarre un helper condiviso `checkVehicleOverlap()` riusabile anche dal futuro follow-up su `departure-bus-assign`, senza however introdurre astrazioni premature per un singolo caller.
- **Query**: `assignments` filtrati per `tenant_id` + `vehicle_label` + range orario del servizio (richiede leggere gli orari del servizio, già disponibili in `service` fetchato a inizio handler).
- **Status HTTP**: `409` su overlap rilevato (coerente con lo stile già usato per `SERVICE_ALREADY_ASSIGNED` in CONC-01).
- **Risposta JSON**: `{ ok:false, error:"VEHICLE_OVERLAP", message:"<messaggio operativo chiaro>" }`.
- **Test**: nuovo file `tests/unit/assign-service-vehicle-overlap.test.ts` — casi validi (nessun overlap, azione `remove` non toccata, nessun `vehicle_label` presente → skip), casi invalidi (overlap reale bloccato con 409, errore di query → 500 fail-closed).
- **Fake**: stesso pattern di mock del client Supabase admin già usato in `assign-service-driver-tenant-guard.test.ts`/`assign-service-concurrency.test.ts`.
- **Fail-closed**: sì — errore di query sull'overlap deve bloccare la scrittura (500), non procedere silenziosamente.
- **Regressioni**: nessuna prevista — task additivo (nuovo controllo), non rimuove funzionalità; verificare che non rompa il caso legittimo di riassegnazione dello stesso servizio allo stesso mezzo (self-overlap da escludere esplicitamente dalla query).
- **Rollback**: revert del singolo commit dedicato.
- **Definition of Done**: come da `assignments-hardening-checklist.md` (fix minimo, test rosso→verde, `pnpm typecheck`/`pnpm lint` puliti, nessun tocco a WhatsApp, commit dedicato che referenzia CONC-03, aggiornamento di questo file a task completato).
- **Commit suggerito**: `fix: block overlapping vehicle assignment in assign-service (CONC-03)`.

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

Poi partire dal "Prossimo task scelto" sopra (M1-10/SEC-05 su `assign-service/route.ts`), seguendo il Definition of Done della checklist. Non implementare due finding nello stesso task.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24 (o nella rivalutazione di questo file per i finding nuovi/aggiornati come RACE-01).
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare HEAD, task completato, prossimo task raccomandato.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
