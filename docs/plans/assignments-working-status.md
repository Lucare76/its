# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: 4 TASK CRITICAL COMPLETATI E PUSHATI, RIALLINEAMENTO ESEGUITO (2026-08-02)

- **Branch**: main
- **HEAD attuale**: `6235acb` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-08-02)
- **Worktree**: pulito (solo cartella non tracciata `exports/`, preesistente, locale, non correlata — da ignorare, non aprire, non modificare)
- **Data ultimo riallineamento**: 2026-08-02

## Task completati (in ordine di commit)

| # | ID | Titolo | Commit | Test dedicati | Reviewer |
|---|---|---|---|---|---|
| 1 | SEC-01 | Tenant guard su `departure-bus-assign` | `27f5624` | `tests/unit/departure-bus-assign-tenant-isolation.test.ts` (13 casi) | APPROVATO |
| 2 | SEC-02 | Tenant guard su `piano-giorno/trips` (create_trip/update_trip/move_services) | `966f2a5` | `tests/unit/piano-giorno-trips-tenant-isolation.test.ts` | APPROVATO |
| 3 | CONC-01 | Controllo errore insert in `assign-service` (falso successo + trip_groups orfano) | `b33ce74` | `tests/unit/assign-service-concurrency.test.ts` (20 casi) | APPROVATO |
| 4 | FUNC-01 | Disponibilità giornaliera + compatibilità geografica batch in `departure-bus-assign` | `6235acb` | `tests/unit/departure-bus-assign-operational-validation.test.ts` (19 casi) | APPROVATO (funzionale + indipendente) |

Tutti e quattro verificati presenti nel codice reale in questa sessione di riallineamento (non solo dal log commit). Nessuna regressione: le 14 failure della suite completa (`pnpm test`) sono preesistenti e identiche sul baseline pre-fix (verificato con `git stash` durante la sessione FUNC-01), in moduli non correlati (San Nicola shift, piano-service-display, vehicle-binding-apply, shuttle-schedules).

## Rivalutazione finding aperti (sessione 2026-08-02)

| ID | Titolo | Severità originale | Severità aggiornata | Stato | Evidenza |
|---|---|---|---|---|---|
| SEC-05 | driver_user_id/driver_profile_id non verificati contro il tenant | MEDIUM | **HIGH** (assign-service, departure-bus-assign) / MEDIUM (trips, protezione incidentale) | APERTO — **prossimo task scelto** | Gap totale confermato in `assign-service`/`departure-bus-assign`; `trips` protetto solo indirettamente da un side-effect di `driver_daily_availability` |
| RACE-01 (nuovo) | DELETE+INSERT non atomico in `departure-bus-assign` (assign_driver) | — (non presente nell'audit originale) | MEDIUM/HIGH | APERTO — nuovo finding, emerso durante l'implementazione di FUNC-01 | Lost update silenzioso confermato per un interleaving concreto; vincolo unique `assignments_service_tenant_unique` intercetta solo un sottoinsieme dei casi |
| CONC-03 | Nessun controllo overlap mezzo in assign-service/departure-bus-assign | HIGH | HIGH (confermata, aggravata) | APERTO | FUNC-01 non è un sostituto (valida geografia/driver, non overlap mezzo); incoerenza con `trips` (che blocca) ora più visibile |
| FUNC-02 | Nessun controllo stato servizio prima dell'assegnazione | MEDIUM | MEDIUM (confermata) | APERTO | `services.status` letto ma mai usato come guardia in nessuna delle tre route |
| FUNC-03 | `access_suspended`/`memberships.suspended` non enforced server-side nelle scritture manuali | MEDIUM | MEDIUM (confermata) | APERTO — separabile da SEC-05 | Zero occorrenze di `suspended` in assign-service/trips/departure-bus-assign; filtro esistente solo in `auto-assign` e lato UI (cosmetic) |
| SEC-03, SEC-04, SEC-06, CONC-02, CONC-06, CONC-07, DB-01..DB-07, TEST-*, UI-*, ML-01, ML-02 | (vedi audit §24) | — | APERTO, non rivalutati in dettaglio in questa sessione | Nessuno di questi è stato toccato dai quattro fix; nessuna evidenza di mitigazione indiretta trovata |

**Nessun finding è stato chiuso indirettamente dai quattro fix.** SEC-01/SEC-02/CONC-01/FUNC-01 sono interventi mirati e non hanno effetti collaterali positivi documentabili su altri finding — anzi CONC-03 risulta leggermente aggravato in visibilità (incoerenza tra route ora più evidente) e SEC-05 è stato riclassificato da MEDIUM a HIGH per le due route con gap totale, sulla base di un'analisi più approfondita del codice attuale (non per un peggioramento oggettivo del codice).

## Top 5 priorità (criteri: cross-tenant > perdita/corruzione dati > falsa conferma > servizio ineseguibile > driver sospeso > overlap > audit > UX > performance > refactoring > ML)

Ordine per **criterio tematico dichiarato** (non per severità assoluta — vedi nota sotto):

1. **SEC-05** (HIGH) — cross-tenant driver ownership. Probabilità: alta (ogni assegnazione manuale). Impatto: integrità dati (FK orfano cross-tenant), leak mitigato ma non escluso in scenari multi-tenant non verificati. Stima: S (per singola route). Dipendenze: nessuna, pattern pronto. Rischio alta stagione: alto.
2. **RACE-01** (MEDIUM/HIGH, nuovo) — lost update silenzioso su `assign_driver`. Probabilità: bassa-media (richiede concorrenza reale sullo stesso batch). Impatto: assegnazione persa senza errore visibile. Stima: XS. Dipendenze: nessuna. Rischio alta stagione: medio-alto (più operatori simultanei sui bus Rete Ischia).
3. **FUNC-02** (MEDIUM) — assegnazione su servizio in stato non valido (categoria "servizio ineseguibile", criterio #4). Probabilità: bassa-media. Impatto: dati/reportistica inquinati, notifiche spurie. Stima: S. Rischio alta stagione: medio.
4. **FUNC-03** (MEDIUM) — driver sospeso assegnabile via API diretta (categoria "driver sospeso", criterio #5). Probabilità: bassa. Impatto: operativo (turno a driver non disponibile), non sicurezza. Stima: S. Rischio alta stagione: medio.
5. **CONC-03** (HIGH) — overlap mezzo non controllato in 2 route su 3 (categoria "overlap autista/mezzo", criterio #6). Probabilità: media. Impatto: doppio impegno mezzo non rilevato. Stima: M. Dipendenze: nessuna diretta. Rischio alta stagione: alto.

**Nota sull'ordine (aggiunta dopo revisione indipendente)**: la posizione di CONC-03 (5°) segue rigorosamente il criterio tematico dichiarato ("overlap" è l'ultimo dei cinque criteri di sicurezza/integrità, dopo "servizio ineseguibile" e "driver sospeso"), **non** la sua severità assoluta — CONC-03 è di fatto l'unico HIGH tra le posizioni 3-5 (FUNC-02/FUNC-03 sono MEDIUM). Se si privilegia la severità sulla categoria tematica, l'ordine pratico consigliato per la pianificazione sarebbe SEC-05 → RACE-01 → CONC-03 → FUNC-02 → FUNC-03. La scelta del prossimo task (sotto) non dipende da questa ambiguità: SEC-05 resta primo in entrambi i criteri.

## Prossimo task scelto: M1-10 — SEC-05, perimetro ridotto a `assign-service/route.ts`

**Motivazione**: tra i candidati (SEC-05, FUNC-02, FUNC-03, CONC-03, RACE-01), SEC-05 è l'unico classificato HIGH con priorità di sicurezza/integrità cross-tenant (criterio #1), ha un fix piccolo (stima S), riusa un pattern già collaudato in questa stessa sessione (`verifyServicesBelongToTenant`/`verifyServiceIdsBelongToTenant`), non richiede migrazioni né tocca UI, ha rollback a singolo commit, ed è testabile a livello handler con lo stesso schema già usato per SEC-01/SEC-02. Il perimetro è stato ridotto alla sola route `assign-service/route.ts` (la più piccola, 274 righe, un solo punto di scrittura) per restare un task atomico a un solo finding; `departure-bus-assign` e `trips` restano follow-up separati dello stesso finding SEC-05.

RACE-01 è il candidato immediatamente successivo (fix ancora più piccolo, XS), consigliato come secondo task.

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
