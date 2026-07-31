# Stato di lavoro — modulo Navette (shuttle)

- **Branch**: main
- **HEAD attuale**: `ac37474` (allineato con `origin/main`, verificato con `git rev-parse HEAD` / `git rev-parse origin/main` il 2026-07-31)
- **Data audit iniziale**: 2026-07-31 (HEAD `db71eaf` al momento dell'audit)
- **Data ultimo aggiornamento di questo file**: 2026-07-31
- **Stato worktree**: pulito (`git status --short` → nessun output) sia all'audit iniziale sia a questo aggiornamento

## Commit già completati (non rifare)

1. `df0cc44` — fix: enforce tenant isolation in ops routes (copre `app/api/ops/escursioni`, `app/api/ops/pickup-runs`; **non** copre `app/api/shuttle-schedules/**`, che risulta comunque tenant-safe per costruzione indipendente)
2. `175a5a8` — fix: require valid_to in shuttle schedule patch
3. `9a37134` — fix: require valid_from in shuttle schedule patch
4. `db71eaf` — test: cover shuttle schedule date range validation
5. `ac37474` (2026-07-31) — fix: block shuttle schedule changes when future services are operational. Mitiga **F-01 (CRITICA)**: `PATCH`/`DELETE` su `app/api/shuttle-schedules/[id]/route.ts` ora rispondono `409 SHUTTLE_HAS_OPERATIONAL_SERVICES` (fail-closed, tenant-scoped, nessun bypass) quando esiste almeno una corsa odierna/futura con `assignments` o `status != 'new'`. Copre e supera l'ambito originariamente pianificato per M1-01 (vedi checklist). 13 test dedicati in `tests/unit/shuttle-schedules-operational-guard.test.ts`.

## Ultimo task completato

**DONE-05 / M1-01 (commit `ac37474`)** — blocco server-side hard di F-01. Verificato in due sessioni di revisione indipendente (implementazione + verifica finale read-only su schema `assignments`/RLS): APPROVATO in entrambe.

## Prossimo task raccomandato

**M1-05 — Verifica tenant su `hotel_id` in POST/PATCH** (vedi `docs/plans/shuttle-hardening-checklist.md`).

Motivazione: con F-01 ora mitigato, il criterio guida torna alla priorità più alta della checklist (tenant isolation e sicurezza). M1-05 corregge F-10, l'unico finding di quella categoria ancora **confermato aperto nel codice attuale** (verificato: `hotel_id` è validato solo come UUID via Zod, mai controllato contro `auth.membership.tenant_id`, in entrambe le route `route.ts` e `[id]/route.ts`). È atomico, a basso rischio, non richiede migrazioni, non tocca WhatsApp. M1-03 (test di tenant isolation, rischio zero) resta valido ma copre un gap di sola copertura test su un comportamento già sicuro, non un bug attivo — priorità secondaria rispetto a M1-05.

## Task bloccati

Nessuno.

## Rischi aperti (non ancora mitigati)

- **F-01 (CRITICA) — MITIGATO** (non più aperto): blocco server-side attivo dal commit `ac37474`. La causa strutturale (modello delete+insert) resta comunque debito tecnico per Milestone 2 (M2-01/M2-02/M2-03): il blocco impedisce la perdita di dati, non elimina il modello a rischio.
- **F-10 (MEDIA, ora priorità operativa più alta)**: `hotel_id` non verificato per appartenenza al tenant richiedente in POST/PATCH — vedi M1-05, prossimo task raccomandato.
- **F-02 (ALTA)**: navette con stessi 7 campi identificativi ma periodi diversi vengono fuse in un'unica scheda in UI; un edit può alterare un periodo non voluto. Nessuna mitigazione di codice sicura disponibile in stagione — solo comunicazione operativa (non ricreare navette con identici hotel/direzione/orario/meeting point/vessel/nome cliente per periodi diversi). Esplicitamente rimandato a Milestone 2, non trattato in questa sessione.
- **F-03 (ALTA)**: operazione di modifica non transazionale, rischio di "navetta scomparsa" su errore parziale (invariato da DONE-05: il blocco impedisce la perdita di assegnazioni quando la navetta è operativa, ma non introduce transazionalità tra delete e insert per il caso non bloccato).
- **F-05 (ALTA)**: bug di fuso orario (UTC invece di Europe/Rome) nella finestra 00:00–02:00 CEST — ora impatta anche la query del nuovo guard (stessa funzione `todayIsoDate()`), ma in modo simmetrico alla cancellazione: nella finestra a rischio il guard esamina lo stesso insieme di righe che verrebbero cancellate, quindi non introduce un varco di sicurezza aggiuntivo — resta comunque un bug di correttezza da correggere (M1-02).
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
