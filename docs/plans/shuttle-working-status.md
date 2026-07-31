# Stato di lavoro — modulo Navette (shuttle)

- **Branch**: main
- **HEAD al momento dell'audit**: `db71eaf` (allineato con `origin/main`, verificato con `git rev-parse HEAD` / `git rev-parse origin/main`)
- **Data audit**: 2026-07-31
- **Stato worktree iniziale**: pulito (`git status --short` → nessun output)

## Commit già completati (non rifare)

1. `df0cc44` — fix: enforce tenant isolation in ops routes (copre `app/api/ops/escursioni`, `app/api/ops/pickup-runs`; **non** copre `app/api/shuttle-schedules/**`, che risulta comunque tenant-safe per costruzione indipendente)
2. `175a5a8` — fix: require valid_to in shuttle schedule patch
3. `9a37134` — fix: require valid_from in shuttle schedule patch
4. `db71eaf` — test: cover shuttle schedule date range validation

## Ultimo task completato

Nessun task di hardening è ancora stato implementato dopo l'audit. L'ultimo lavoro applicativo sul modulo è il commit `db71eaf` (test di regressione sul range date). Questo audit (documenti in `docs/audits/` e `docs/plans/`) è puramente di analisi, nessun codice applicativo è stato toccato.

## Prossimo task raccomandato

**M1-03 — Test di tenant isolation dedicato per `shuttle-schedules`** (vedi `docs/plans/shuttle-hardening-checklist.md`).

Motivazione: rischio nullo (solo aggiunta di un file di test), nessuna dipendenza da altri task, e chiude il gap più urgente segnalato nell'audit lato sicurezza (F-07) prima di toccare qualunque logica di scrittura. Subito dopo, procedere con M1-02 (fix fuso orario) seguendo l'ordine indicato nella checklist.

## Task bloccati

Nessuno al momento. Il task M1-01 (avviso bloccante in UI, mitigazione di F-01 CRITICA) dipende dalla decisione su come contare "corse assegnate" — richiede una breve verifica manuale extra (leggere lo schema di `assignments`/`status_events` già fatta in questo audit, riutilizzabile) ma non è bloccato da nulla di esterno.

## Rischi aperti (non ancora mitigati)

- **F-01 (CRITICA)**: PATCH/DELETE su una navetta cancella a cascata assegnazioni driver/veicolo e stato delle corse future (`ON DELETE CASCADE` da `services` verso `assignments`/`status_events`). Nessuna mitigazione attiva finché M1-01 non è implementato. **Comunicare agli operatori**, nel frattempo, di evitare modifiche a navette con corse già assegnate senza prima verificare manualmente il piano giorno.
- **F-02 (ALTA)**: navette con stessi 7 campi identificativi ma periodi diversi vengono fuse in un'unica scheda in UI; un edit può alterare un periodo non voluto. Nessuna mitigazione di codice sicura disponibile in stagione — solo comunicazione operativa (non ricreare navette con identici hotel/direzione/orario/meeting point/vessel/nome cliente per periodi diversi).
- **F-03 (ALTA)**: operazione di modifica non transazionale, rischio di "navetta scomparsa" su errore parziale.
- **F-05 (ALTA)**: bug di fuso orario (UTC invece di Europe/Rome) nella finestra 00:00–02:00 CEST.
- **F-06 (ALTA)**: query GET senza filtro, degrado prestazionale crescente con l'accumulo dati stagionali.

Dettaglio completo di tutti i finding in `docs/audits/shuttle-module-audit.md`.

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
