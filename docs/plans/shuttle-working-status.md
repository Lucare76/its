# Stato di lavoro — modulo Navette (shuttle)

- **Branch**: main
- **HEAD attuale**: `eb4f978` (allineato con `origin/main`, verificato con `git rev-parse HEAD` / `git rev-parse origin/main` il 2026-07-31)
- **Data audit iniziale**: 2026-07-31 (HEAD `db71eaf` al momento dell'audit)
- **Data ultimo aggiornamento di questo file**: 2026-07-31
- **Stato worktree**: pulito (`git status --short` → nessun output) a ogni verifica successiva

## Commit già completati (non rifare)

1. `df0cc44` — fix: enforce tenant isolation in ops routes (copre `app/api/ops/escursioni`, `app/api/ops/pickup-runs`; **non** copre `app/api/shuttle-schedules/**`, che risulta comunque tenant-safe per costruzione indipendente)
2. `175a5a8` — fix: require valid_to in shuttle schedule patch
3. `9a37134` — fix: require valid_from in shuttle schedule patch
4. `db71eaf` — test: cover shuttle schedule date range validation
5. `ac37474` (2026-07-31) — fix: block shuttle schedule changes when future services are operational. Mitiga **F-01 (CRITICA)**: `PATCH`/`DELETE` su `app/api/shuttle-schedules/[id]/route.ts` ora rispondono `409 SHUTTLE_HAS_OPERATIONAL_SERVICES` (fail-closed, tenant-scoped, nessun bypass) quando esiste almeno una corsa odierna/futura con `assignments` o `status != 'new'`. Copre e supera l'ambito originariamente pianificato per M1-01 (vedi checklist). 13 test dedicati in `tests/unit/shuttle-schedules-operational-guard.test.ts`.
6. `b909349` (2026-07-31) — fix: validate hotel_id belongs to requesting tenant in shuttle schedules API. Mitiga **F-10 (MEDIA)**: `POST`/`PATCH` verificano `hotel_id` contro `public.hotels` filtrato per `id` + `auth.membership.tenant_id` prima di ogni scrittura (nel PATCH, anche prima del guard F-01); mismatch → `400 INVALID_HOTEL_FOR_TENANT`; errore query → `500` fail-closed. 12 test dedicati in `tests/unit/shuttle-schedules-hotel-tenant-guard.test.ts`. Nessun mock esistente modificato.
7. `eb4f978` (2026-07-31) — fix: avoid leaking raw database errors from shuttle schedules API. Mitiga **F-11 (MEDIA)**: `GET`/`POST`/`PATCH`/`DELETE` non restituiscono più `error.message` grezzo al client; ogni errore interno è ora loggato lato server via `auditLog` (dettaglio completo, incl. `scheduleId` quando disponibile) mentre il client riceve un messaggio generico stabile; status HTTP invariati. Corretti anche i due catch dell'hotel-check F-10, in precedenza privi di log. 10 test dedicati in `tests/unit/shuttle-schedules-error-sanitization.test.ts`, incluse 4 regressioni esplicite su 400/409/200.

## Ultimo task completato

**DONE-07 / M1-06 (commit `eb4f978`)** — sanificazione messaggi di errore. Reviewer indipendente read-only: APPROVATO (assenza `error.message`/`details`/`hint`/`code`/`stack` verificata su tutti i percorsi, log presente ovunque, nessuna regressione F-01/F-10, nessun file vietato toccato, WhatsApp intatto).

## Task corrente

**M1-02 — Fix `todayIsoDate()` per usare il fuso Europe/Rome invece di UTC** (F-05, vedi `docs/plans/shuttle-hardening-checklist.md`).

Motivazione: con F-01, F-10 e F-11 già mitigati, applicando l'ordine di priorità (bug attivi di sicurezza → bug attivi di correttezza → osservabilità → test → performance), M1-02 è l'unico bug attivo di correttezza rimasto in Milestone 1: `todayIsoDate()` calcola "oggi" in UTC anziché nel fuso operativo italiano, alterando il perimetro di righe considerate "future" nella finestra 00:00–02:00 ora legale (CEST) / 00:00–01:00 ora solare (CET). Atomico, nessuna migrazione, non tocca WhatsApp, rischio basso.

## Task bloccati

Nessuno.

## Rischi aperti (non ancora mitigati)

- **F-01 (CRITICA) — MITIGATO**: blocco server-side attivo dal commit `ac37474`. Causa strutturale (modello delete+insert) resta debito tecnico per Milestone 2.
- **F-10 (MEDIA) — MITIGATO**: verifica tenant su `hotel_id` attiva dal commit `b909349`.
- **F-11 (MEDIA) — MITIGATO**: messaggi di errore sanificati dal commit `eb4f978`.
- **F-05 (ALTA, ora priorità operativa più alta)**: bug di fuso orario (UTC invece di Europe/Rome) — vedi M1-02, task corrente.
- **F-02 (ALTA)**: navette con stessi 7 campi identificativi ma periodi diversi vengono fuse in un'unica scheda in UI; un edit può alterare un periodo non voluto. Nessuna mitigazione di codice sicura disponibile in stagione — solo comunicazione operativa. Esplicitamente rimandato a Milestone 2, non trattato in questa sessione.
- **F-03 (ALTA)**: operazione di modifica non transazionale, rischio di "navetta scomparsa" su errore parziale (invariato).
- **F-06 (ALTA)**: query GET senza filtro, degrado prestazionale crescente con l'accumulo dati stagionali. Invariato.

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
