# Stato di lavoro — modulo Navette (shuttle)

- **Branch**: main
- **HEAD attuale**: `b62c1a0` (allineato con `origin/main`, verificato con `git rev-parse HEAD` / `git rev-parse origin/main` il 2026-07-31). Il worktree contiene modifiche applicative + test non ancora committati (`app/api/shuttle-schedules/route.ts`, `app/api/shuttle-schedules/[id]/route.ts`, `tests/unit/shuttle-schedules-tenant-isolation.test.ts`, `tests/unit/shuttle-schedules-audit-log.test.ts`) — nessun commit/push eseguito in questa sessione, per istruzione esplicita.
- **Data audit iniziale**: 2026-07-31 (HEAD `db71eaf` al momento dell'audit)
- **Data ultimo aggiornamento di questo file**: 2026-07-31
- **Stato worktree**: pulito a inizio sessione; a fine sessione contiene modifiche applicative + test non committati (vedi sopra)

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

**Non ancora committato** (codice + test pronti, revisionati e approvati, in attesa di commit): audit aggregato M1-08/F-04 — vedi "Ultimo task completato" sotto.

## Ultimo task completato

**M1-08 / F-04 (ridefinita) — codice pronto, non ancora committato.** Audit persistente e aggregato (`shuttle_schedule_created`/`_updated`/`_deleted` via `auditLog`→`ops_audit_events`) per POST/PATCH/DELETE riusciti su `shuttle-schedules`, con snapshot funzionale `previous`/`next`, conteggi e range reali. Guard F-01 esteso (stessa query, stesso comportamento) per evitare una select ridondante. Fallimento parziale del PATCH ora riconoscibile nell'evento di errore (`deletePhaseCompleted`). 33 test in `tests/unit/shuttle-schedules-audit-log.test.ts`, esperimento di sensibilità eseguito e verificato. Reviewer indipendente: APPROVATO.

## Task corrente

Nessun task applicativo in corso. **M1-04 (filtro/performance GET, F-06) è l'unico task M1 ancora aperto.** Non iniziato in questa sessione.

## Task bloccati

Nessuno.

## Rischi aperti (non ancora mitigati)

- **F-01, F-10, F-11, F-05, F-12, F-07, F-04 — tutti MITIGATI.** Causa strutturale di F-01 (modello delete+insert) resta debito tecnico per Milestone 2; il limite transazionale del PATCH (nessun rollback tra delete e insert) resta invariato, ora solo più visibile grazie a `deletePhaseCompleted` nell'evento di errore.
- **F-02 (ALTA)**: navette con stessi 7 campi identificativi ma periodi diversi vengono fuse in un'unica scheda in UI. Nessuna mitigazione di codice sicura disponibile in stagione — solo comunicazione operativa. Rimandato a Milestone 2.
- **F-03 (ALTA)**: operazione di modifica non transazionale, rischio di "navetta scomparsa" su errore parziale (invariato).
- **F-06 (ALTA)**: query GET senza filtro, degrado prestazionale crescente con l'accumulo dati stagionali. Vedi M1-04, unico task M1 aperto.

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
