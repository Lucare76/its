# Stato di lavoro — modulo Navette (shuttle)

## STATO GENERALE: MILESTONE 1 NAVETTE COMPLETATA (2026-07-31)

- **Branch**: main
- **HEAD attuale**: `9a78e3b` (allineato con `origin/main`, verificato con `git rev-parse HEAD` / `git rev-parse origin/main` il 2026-07-31). Worktree pulito.
- **Data audit iniziale**: 2026-07-31 (HEAD `db71eaf` al momento dell'audit)
- **Data ultimo aggiornamento di questo file**: 2026-07-31
- **Stato worktree**: pulito

## Commit già completati (non rifare)

1. `df0cc44` — fix: enforce tenant isolation in ops routes (copre `app/api/ops/escursioni`, `app/api/ops/pickup-runs`; **non** copre `app/api/shuttle-schedules/**`, che risulta comunque tenant-safe per costruzione indipendente)
2. `175a5a8` — fix: require valid_to in shuttle schedule patch
3. `9a37134` — fix: require valid_from in shuttle schedule patch
4. `db71eaf` — test: cover shuttle schedule date range validation
5. `ac37474` (2026-07-31) — fix: block shuttle schedule changes when future services are operational. Mitiga **F-01 (CRITICA)**. 13 test in `tests/unit/shuttle-schedules-operational-guard.test.ts`.
6. `b909349` (2026-07-31) — fix: validate hotel_id belongs to requesting tenant in shuttle schedules API. Mitiga **F-10 (MEDIA)**. 12 test in `tests/unit/shuttle-schedules-hotel-tenant-guard.test.ts`.
7. `eb4f978` (2026-07-31) — fix: avoid leaking raw database errors from shuttle schedules API. Mitiga **F-11 (MEDIA)**, copre anche M1-09/F-17 (log su tutti i `catch`). 10 test in `tests/unit/shuttle-schedules-error-sanitization.test.ts`.
8. `988cf4b` (2026-07-31) — fix: compute shuttle schedule "today" cutoff in Europe/Rome timezone. Mitiga **F-05 (ALTA)**: `todayIsoDate(now=new Date())` usa `Intl.DateTimeFormat` con `timeZone:"Europe/Rome"`, DST gestita automaticamente. 22 test in `tests/unit/shuttle-schedules-rome-date.test.ts`.
9. `d687bd0` (2026-07-31) — fix: handle malformed shuttle schedule id in PATCH route. Mitiga **F-12 (BASSA)**: decode avvolto in try/catch + validazione struttura minima, `400` controllato invece di eccezione non gestita. 13 test in `tests/unit/shuttle-schedules-invalid-id.test.ts`.
10. `e6f4d95` — test: add handler-level tenant isolation coverage for shuttle schedules API. Copre **F-07**, nessun bug trovato, nessun codice di produzione modificato. 28 test in `tests/unit/shuttle-schedules-tenant-isolation.test.ts`.
11. `b62c1a0` — docs: mark M1-02 M1-03 M1-07 M1-09 complete and recommend M1-08 next.
12. `aaebe8c` (2026-07-31) — feat: add aggregated audit log for shuttle schedule create update delete. Mitiga **F-04 (ridefinita)**: audit aggregato via `auditLog`→`ops_audit_events`, nessun log per riga. 33 test in `tests/unit/shuttle-schedules-audit-log.test.ts`.
13. `9a78e3b` (2026-07-31) — docs: mark M1-08 complete and set M1-04 as the only open M1 task.

## Ultimo task completato

**M1-08 / F-04 (ridefinita)** — commit `aaebe8c` + `9a78e3b`. Audit persistente e aggregato per POST/PATCH/DELETE riusciti su `shuttle-schedules`. Reviewer indipendente: APPROVATO.

**Chiusura formale M1-04 / F-06** (questa sessione, solo documentazione) — analizzato a fondo il rischio prestazionale del `GET` (reale ma senza incidenti osservati) e le due possibili mitigazioni (filtro data, filtro tipo servizio): **nessuna delle due è risultata sicura per l'implementazione runtime in alta stagione** (regressione certa sulle programmazioni concluse per il filtro data; sicurezza non dimostrabile senza dati di produzione per il filtro tipo servizio; nessuna delle due risolve F-02). M1-04 è chiuso come **rischio accettato e documentato**, rinviato a Milestone 2 (M2-15). **Nessun codice applicativo modificato.**

## MILESTONE 1 — NESSUN TASK APERTO

Tutti i task Milestone 1 sono COMPLETATI o formalmente CHIUSI con motivazione documentata (M1-04). Questo **non equivale a "nessun rischio"**: vedi "Rischi residui (Milestone 2)" sotto.

## Prossimo passo raccomandato

**Avviare l'audit del modulo Assegnazioni** (driver/veicolo — tabella `assignments`, gestione turni/piano-giorno), seguendo lo stesso metodo usato per il modulo Navette (audit read-only → mappatura → finding classificati → checklist atomica).

## Task bloccati

Nessuno.

## Rischi residui (Milestone 2) — non risolti, non oggetto di questa Milestone 1

- **F-02 (ALTA) — fusione dei periodi**: navette con stessi 7 campi identificativi ma periodi diversi (anche di stagioni diverse) vengono fuse in un'unica scheda derivata, con `valid_from`/`valid_to`/`days_of_week` potenzialmente fuorvianti. Nessuna mitigazione di codice sicura possibile senza la soluzione strutturale (M2-01). Solo comunicazione operativa nel frattempo.
- **F-06 (ALTA) — `GET` full-history con `select("*")`**: legge l'intero storico `services` del tenant (non filtrato per data né per tipo servizio) ad ogni caricamento della pagina Settings → Navette. Rischio prestazionale reale e crescente con l'accumulo di dati stagionali, **nessun incidente osservato ad oggi**. Chiuso come rischio accettato in M1-04 (vedi checklist); la correzione va progettata **insieme** a F-02 (M2-15), non isolatamente.
- **PATCH non transazionale**: `deleteMatchingFutureServices` e `insertRows` restano due chiamate Supabase separate senza rollback. Un fallimento tra le due lascia dati in stato parziale (non ripristinato automaticamente); ora almeno riconoscibile nell'evento di errore tramite `deletePhaseCompleted` (M1-08), ma il difetto strutturale resta — soluzione in M2-02/M2-03.

Questi tre rischi **appartengono esplicitamente a Milestone 2** e non devono essere riproposti come task M1 in futuro senza una nuova valutazione esplicita.

Dettaglio completo di tutti i finding in `docs/audits/shuttle-module-audit.md` (documento storico, non aggiornato oltre l'audit iniziale se non strettamente necessario).

## Vincolo WhatsApp

Il modulo WhatsApp (template, webhook Meta, invii, convocazioni, `lib/server/whatsapp*`) è **operativo in produzione e non deve essere toccato**. Nessun task di questa checklist lo tocca; qualunque futura modifica al modulo Navette che influenzi indirettamente notifiche/invii WhatsApp (es. cambio di `status` sulle righe `services`) va valutata con particolare attenzione perché `status_events`/`whatsapp_events` referenziano `services.id` con `ON DELETE CASCADE`/`ON DELETE SET NULL` — questo è il meccanismo alla base di F-01, ma la correzione riguarda la logica del modulo Navette, non il codice WhatsApp stesso.

## Istruzioni per riprendere il lavoro da un'altra postazione

1. Clonare/aggiornare il repository sulla nuova postazione.
2. Verificare di essere su `main` e allineati: `git status --short` (deve essere pulito) e confrontare `git rev-parse HEAD` con l'hash sopra o con `git rev-parse origin/main`.
3. Comando pull raccomandato:
   ```
   git checkout main
   git pull --ff-only origin main
   ```
   (`--ff-only` per evitare merge accidentali se la cronologia locale fosse divergente; se fallisce, indagare prima di forzare nulla.)
4. Leggere, in ordine: `docs/audits/shuttle-module-audit.md` (finding completi), `docs/plans/shuttle-hardening-checklist.md` (task atomici), questo file per lo stato corrente.
5. Riprendere dal "Prossimo task raccomandato" sopra, seguendo l'ordine di esecuzione indicato nella checklist.

## Regola operativa per ogni task

**Un task, un test, un reviewer, un commit, un push.** Nessun task deve essere accorpato ad altri senza necessità esplicita indicata nella checklist (es. M1-06+M1-09 sono accorpabili solo perché entrambi toccano lo stesso blocco `catch`). Ogni commit deve poter essere revertito singolarmente senza impattare gli altri. Non pushare senza che i comandi di verifica del task (tipicamente `pnpm exec vitest run` mirato + `pnpm typecheck`) siano stati eseguiti con esito positivo.
