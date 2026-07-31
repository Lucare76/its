# Checklist di hardening — modulo Navette (shuttle)

Riferimento: `docs/audits/shuttle-module-audit.md` (audit del 2026-07-31, HEAD `db71eaf`).

Regola generale per ogni task: **un task = un test = un commit facilmente reversibile**. Nessun task deve toccare più di quanto dichiarato in "File consentiti". Nessun task deve toccare WhatsApp.

## Task completati (non rifare)

| Codice | Descrizione | Commit | Verifica |
|---|---|---|---|
| DONE-01 | Tenant isolation nelle route operative (`escursioni`, `pickup-runs`) | `df0cc44` | `tests/unit/escursioni-tenant-isolation.test.ts`, `tests/unit/pickup-runs-tenant-isolation.test.ts` |
| DONE-02 | `valid_to` obbligatorio nel PATCH shuttle schedules | `175a5a8` | `tests/unit/shuttle-schedules-patch-valid-to.test.ts` |
| DONE-03 | `valid_from` obbligatorio nel PATCH shuttle schedules | `9a37134` | `tests/unit/shuttle-schedules-patch-valid-from.test.ts` |
| DONE-04 | Regressione `valid_to >= valid_from` (range date) | `db71eaf` | `tests/unit/shuttle-schedules-patch-date-range.test.ts` |

Nota: DONE-01 non copre `app/api/shuttle-schedules/**`, che però risulta tenant-safe per costruzione indipendente (vedi F-07 nell'audit). Il task M1-03 sotto copre solo il gap di test, non un bug.

---

## MILESTONE 1 — Alta stagione (correzioni sicure, atomiche, basso rischio)

### M1-01 — Avviso bloccante in UI prima di modificare/eliminare navette con corse future già assegnate
- **Milestone**: 1 · **Priorità**: MASSIMA (mitiga F-01, CRITICA)
- **Obiettivo**: impedire che un operatore salvi/elimini una navetta senza sapere che perderà assegnazioni driver/veicolo e stato delle corse future.
- **Problema risolto**: F-01 (audit) — palliativo, non risolve la causa strutturale.
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`, eventuale nuovo endpoint di sola lettura `app/api/shuttle-schedules/[id]/impact/route.ts` (GET, conta righe future con `assignments`/`status != 'new'`).
- **File vietati**: `lib/shuttle-schedules.ts` (logica di delete/insert esistente NON va toccata in questo task), qualunque file WhatsApp.
- **Modifiche previste**: nuovo GET di sola lettura che conta le corse future coinvolte e quelle già assegnate/lavorate; in UI, prima del PATCH/DELETE, chiamare questo endpoint e mostrare un `confirm()` esplicito con i numeri, bloccando il salvataggio se l'utente annulla.
- **Test obbligatori**: test unitario sul nuovo endpoint GET (conteggio corretto assegnate/non assegnate, tenant isolation).
- **Comandi di verifica**: `pnpm exec vitest run tests/unit/shuttle-schedules-impact.test.ts`, `pnpm typecheck`.
- **Rollback**: rimuovere il nuovo file route + revert delle poche righe in `page.tsx` che chiamano l'endpoint prima del submit.
- **Definition of Done**: un operatore che tenta di modificare/eliminare una navetta con corse future assegnate vede un avviso con conteggio reale prima di poter confermare.
- **Dipendenze**: nessuna.
- **Feature flag**: non necessaria (comportamento additivo, non distruttivo se l'endpoint fallisce — in tal caso il salvataggio prosegue senza avviso, da loggare).
- **Rischio**: basso (solo lettura aggiuntiva, nessuna modifica alla logica di scrittura esistente).
- **Stato**: DA FARE.
- **Commit suggerito**: `feat: warn before shuttle edit/delete affects assigned future services`

### M1-02 — Fix `todayIsoDate()` per usare il fuso Europe/Rome invece di UTC
- **Milestone**: 1 · **Priorità**: ALTA (F-05)
- **Obiettivo**: evitare che nella finestra 00:00–02:00 CEST una data odierna italiana venga trattata come "passata" in UTC, alterando il perimetro di righe cancellate/rigenerate.
- **Problema risolto**: F-05.
- **File consentiti**: `app/api/shuttle-schedules/route.ts`, `app/api/shuttle-schedules/[id]/route.ts` (entrambe le definizioni duplicate di `todayIsoDate`).
- **File vietati**: qualunque altro file che usa date (fuori perimetro navette), file WhatsApp.
- **Modifiche previste**: sostituire `new Date().toISOString().slice(0,10)` con un calcolo esplicito in `Europe/Rome` (es. `new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date())`), identico nei due file.
- **Test obbligatori**: nuovo test che mocka `Date` a un istante UTC nella finestra 22:00–23:59 UTC (= 00:00–01:59 CEST) e verifica che `todayIsoDate()` (o la funzione esportata, se estratta) ritorni la data italiana corretta, non quella UTC.
- **Comandi di verifica**: `pnpm exec vitest run tests/unit/shuttle-schedules-patch-date-range.test.ts tests/unit/shuttle-schedules-patch-valid-from.test.ts tests/unit/shuttle-schedules-patch-valid-to.test.ts`, `pnpm typecheck`.
- **Rollback**: revert della singola riga modificata in ciascuno dei 2 file.
- **Definition of Done**: `todayIsoDate()` restituisce sempre la data corrente in Italia, verificato da test con orario mockato.
- **Dipendenze**: nessuna.
- **Feature flag**: non necessaria.
- **Rischio**: basso — funzione pura, cambio isolato, ben testabile.
- **Stato**: DA FARE.
- **Commit suggerito**: `fix: compute shuttle schedule "today" cutoff in Europe/Rome timezone`

### M1-03 — Test di tenant isolation dedicato per `shuttle-schedules`
- **Milestone**: 1 · **Priorità**: ALTA (F-07)
- **Obiettivo**: garantire con un test di regressione che PATCH/DELETE/GET/POST filtrino sempre per `tenant_id` di sessione, anche se un futuro refactor tocca questo file.
- **Problema risolto**: F-07 (gap di test coverage, non un bug attuale).
- **File consentiti**: nuovo file `tests/unit/shuttle-schedules-tenant-isolation.test.ts`.
- **File vietati**: nessuna modifica a `app/api/shuttle-schedules/**` o `lib/shuttle-schedules.ts` in questo task.
- **Modifiche previste**: nuovo test che, con mock del client Supabase, verifica che ogni chiamata `.eq("tenant_id", ...)` nel delete/insert/select usi sempre `auth.membership.tenant_id`, anche quando l'`id` decodificato "suggerisce" un hotel/cliente diverso.
- **Test obbligatori**: il file stesso.
- **Comandi di verifica**: `pnpm exec vitest run tests/unit/shuttle-schedules-tenant-isolation.test.ts`.
- **Rollback**: cancellazione del nuovo file di test.
- **Definition of Done**: test verde, copre PATCH e DELETE con scenario cross-tenant simulato.
- **Dipendenze**: nessuna.
- **Feature flag**: non applicabile.
- **Rischio**: nullo (solo aggiunta di test).
- **Stato**: DA FARE.
- **Commit suggerito**: `test: add tenant isolation coverage for shuttle schedules API`

### M1-04 — Filtrare `GET /api/shuttle-schedules` per tipo servizio e data
- **Milestone**: 1 · **Priorità**: ALTA (F-06)
- **Obiettivo**: ridurre il costo della query GET e correggere il `valid_from` mostrato quando esistono vecchie navette con la stessa chiave.
- **Problema risolto**: F-06, in parte F-15.
- **File consentiti**: `lib/server/fetch-all-services.ts` (o nuova funzione dedicata `fetchShuttleLikeServices` per non alterare gli altri chiamanti di `fetchAllServices`), `app/api/shuttle-schedules/route.ts`.
- **File vietati**: altri chiamanti di `fetchAllServices` fuori dal modulo navette.
- **Modifiche previste**: introdurre una query filtrata (`booking_service_kind in (navetta, shuttle_hotel)` con fallback su `vessel ilike 'navetta'`, e `date >= oggi - 400 giorni` per mantenere una finestra storica ragionevole senza scaricare tutto) usata solo dalla rotta GET/POST di shuttle-schedules; **non modificare** `fetchAllServices` usata da altri moduli.
- **Test obbligatori**: nuovo test che verifica che `deriveShuttleSchedules` riceva solo servizi filtrati e che il conteggio di righe scaricate sia inferiore rispetto al full-scan su un dataset misto simulato.
- **Comandi di verifica**: `pnpm exec vitest run`, `pnpm typecheck`, verifica manuale in dev (`pnpm dev`) che la pagina Settings → Navette mostri le stesse navette di prima.
- **Rollback**: ripristinare la chiamata a `fetchAllServices` esistente in `route.ts`.
- **Definition of Done**: GET shuttle-schedules non scarica più l'intera tabella `services`; test verde; verifica manuale in dev che nessuna navetta esistente sparisca dalla lista.
- **Dipendenze**: nessuna.
- **Feature flag**: consigliata (`SHUTTLE_FILTERED_FETCH=1`) per poter disattivare rapidamente in caso di regressione durante l'alta stagione.
- **Rischio**: medio — cambia cosa il GET restituisce; richiede verifica manuale attenta prima del deploy in stagione.
- **Stato**: DA FARE.
- **Commit suggerito**: `perf: filter shuttle-schedules GET query by service kind and date range`

### M1-05 — Verifica tenant su `hotel_id` in POST/PATCH
- **Milestone**: 1 · **Priorità**: MEDIA (F-10)
- **Obiettivo**: impedire di associare una navetta a un hotel che non appartiene al tenant corrente.
- **Problema risolto**: F-10.
- **File consentiti**: `app/api/shuttle-schedules/route.ts`, `app/api/shuttle-schedules/[id]/route.ts`.
- **Modifiche previste**: se `hotel_id` è presente nel payload, query `select id from hotels where id = hotel_id and tenant_id = auth.membership.tenant_id`; 400 esplicito se non trovato.
- **Test obbligatori**: test che invia un `hotel_id` di un tenant diverso e verifica risposta 400, sia su POST che su PATCH.
- **Comandi di verifica**: `pnpm exec vitest run`, `pnpm typecheck`.
- **Rollback**: rimuovere il blocco di verifica aggiunto.
- **Definition of Done**: richieste con `hotel_id` cross-tenant vengono rifiutate con 400.
- **Dipendenze**: nessuna.
- **Feature flag**: non necessaria.
- **Rischio**: basso.
- **Stato**: DA FARE.
- **Commit suggerito**: `fix: validate hotel_id belongs to requesting tenant in shuttle schedules API`

### M1-06 — Sanificare i messaggi di errore restituiti al client
- **Milestone**: 1 · **Priorità**: MEDIA (F-11)
- **Obiettivo**: evitare di esporre messaggi Postgres grezzi nelle risposte 500.
- **File consentiti**: `app/api/shuttle-schedules/route.ts`, `app/api/shuttle-schedules/[id]/route.ts`.
- **Modifiche previste**: nei blocchi `catch`, loggare `error` (console.error o `auditLog` se disponibile in questo contesto) e restituire un messaggio generico al client, mantenendo lo status code.
- **Test obbligatori**: test che verifica che la risposta 500 non contenga più il messaggio originale dell'errore Supabase mockato.
- **Comandi di verifica**: `pnpm exec vitest run`, `pnpm typecheck`.
- **Rollback**: ripristinare `error.message` nella risposta.
- **Definition of Done**: nessun messaggio Postgres/interno raggiunge il client; log presente lato server.
- **Dipendenze**: nessuna.
- **Rischio**: basso.
- **Stato**: DA FARE.
- **Commit suggerito**: `fix: avoid leaking raw database errors from shuttle schedules API`

### M1-07 — `decodeShuttleScheduleId` dentro try/catch nel PATCH
- **Milestone**: 1 · **Priorità**: BASSA (F-12)
- **Obiettivo**: coerenza di gestione errori tra PATCH e DELETE per id malformati.
- **File consentiti**: `app/api/shuttle-schedules/[id]/route.ts`.
- **Modifiche previste**: spostare/avvolgere `decodeShuttleScheduleId(id)` in un try/catch dedicato prima della validazione Zod, risposta 400 `"Id navetta non valido."` in caso di errore di parsing.
- **Test obbligatori**: test PATCH con id non-base64/non-JSON valido → verifica 400 invece di eccezione non gestita.
- **Comandi di verifica**: `pnpm exec vitest run`, `pnpm typecheck`.
- **Rollback**: revert del blocco try/catch aggiunto.
- **Definition of Done**: PATCH con id malformato risponde 400 controllato, allineato al comportamento di DELETE.
- **Rischio**: basso.
- **Stato**: DA FARE.
- **Commit suggerito**: `fix: handle malformed shuttle schedule id in PATCH route`

### M1-08 — Log di audit per cancellazione navetta
- **Milestone**: 1 · **Priorità**: ALTA (F-04)
- **Obiettivo**: tracciabilità delle cancellazioni massive di corse navetta.
- **File consentiti**: `app/api/shuttle-schedules/[id]/route.ts`.
- **Modifiche previste**: prima della delete in `deleteMatchingFutureServices` (o subito dopo, con conteggio righe interessate), scrivere una entry riepilogativa (utente, tenant, chiave navetta, numero righe, data/ora) — riusando `service_deletion_log` se lo schema lo consente senza migrazione, altrimenti tramite `auditLog` applicativo già presente nel progetto.
- **Test obbligatori**: test che verifica che la funzione di log venga chiamata con i parametri attesi in caso di DELETE riuscito.
- **Comandi di verifica**: `pnpm exec vitest run`, `pnpm typecheck`.
- **Rollback**: rimuovere la chiamata di log aggiunta.
- **Definition of Done**: ogni cancellazione di navetta lascia una traccia verificabile (chi, quando, quante righe).
- **Dipendenze**: verificare lo schema di `service_deletion_log` prima di implementare (se richiede `service_id` singolo non compatibile con cancellazione multipla, usare `auditLog` generico invece).
- **Rischio**: basso (operazione additiva).
- **Stato**: DA FARE.
- **Commit suggerito**: `feat: log shuttle schedule deletions for audit trail`

### M1-09 — Log degli errori di scrittura (PATCH/POST/DELETE)
- **Milestone**: 1 · **Priorità**: MEDIA (F-17)
- **Obiettivo**: avere traccia in log quando una scrittura fallisce, per diagnosi rapida in produzione.
- **File consentiti**: `app/api/shuttle-schedules/route.ts`, `app/api/shuttle-schedules/[id]/route.ts`.
- **Modifiche previste**: aggiungere `auditLog`/`console.error` nei blocchi `catch` esistenti (si può accorpare con M1-06).
- **Test obbligatori**: verifica che la funzione di log venga invocata nei path di errore già coperti dai test esistenti.
- **Comandi di verifica**: `pnpm exec vitest run`, `pnpm typecheck`.
- **Rollback**: rimuovere le chiamate di log aggiunte.
- **Definition of Done**: ogni errore di scrittura produce una entry di log server-side.
- **Rischio**: basso.
- **Stato**: DA FARE (può essere fuso con M1-06 nello stesso commit se il reviewer lo preferisce).
- **Commit suggerito**: `feat: log write failures in shuttle schedules API`

---

## MILESTONE 1.5 — UX sicura (nessun redesign)

### M1.5-01 — Indicare i campi obbligatori e bloccare il submit lato client
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: asterischi su Hotel/Nome, Orario, Dal, Al; controllo `handleSave` che impedisce la fetch se questi campi sono vuoti, mostrando un messaggio chiaro.
- **Problema risolto**: F-18.
- **Test**: nessun test unitario automatizzato richiesto (componente React di pagina) — verifica manuale in dev descritta nella Definition of Done.
- **DoD**: tentare il salvataggio con campi obbligatori vuoti mostra un errore immediato senza chiamata di rete.
- **Rischio**: basso. **Stato**: DA FARE.
- **Commit suggerito**: `feat(ux): require key fields before submitting shuttle schedule form`

### M1.5-02 — Allineare terminologia "Direzione" a "Andata/Ritorno"
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: cambiare le label delle option del select Direzione per includere "Andata"/"Ritorno" coerentemente con la tabella.
- **Problema risolto**: F-19.
- **DoD**: le etichette in form e tabella usano la stessa terminologia.
- **Rischio**: basso (solo testo). **Stato**: DA FARE.
- **Commit suggerito**: `fix(ux): align shuttle direction labels with table terminology`

### M1.5-03 — Nota esplicita sul default giorni settimana (Domenica esclusa)
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: testo di aiuto sotto il selettore giorni che chiarisce quali giorni sono selezionati di default.
- **Problema risolto**: F-20.
- **DoD**: un operatore che apre il form "+ Aggiungi" vede chiaramente che la Domenica non è preselezionata.
- **Rischio**: basso. **Stato**: DA FARE.
- **Commit suggerito**: `fix(ux): clarify default weekday selection for new shuttle schedules`

### M1.5-04 — Refetch dopo DELETE invece di rimozione ottimistica locale
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: sostituire il `filter()` locale post-delete con `await fetchSchedules(token)`, come già avviene dopo il save.
- **Problema risolto**: F-21.
- **Test**: verifica manuale in dev (elimina una navetta, controlla che la lista rifletta lo stato server).
- **DoD**: dopo una delete, la lista è sempre sincronizzata col server.
- **Rischio**: basso. **Stato**: DA FARE.
- **Commit suggerito**: `fix(ux): refetch shuttle schedules after delete instead of optimistic filter`

### M1.5-05 — Disabled state sul bottone "Elimina" durante la richiesta
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: stato `deletingId` per riga, bottone disabilitato durante la richiesta DELETE in corso.
- **Problema risolto**: F-22.
- **DoD**: doppio click su "Elimina" non genera due richieste.
- **Rischio**: basso. **Stato**: DA FARE.
- **Commit suggerito**: `fix(ux): prevent double-click on shuttle schedule delete button`

### M1.5-06 — Messaggi di errore fallback più chiari
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: sostituire i 3 messaggi fallback generici con testo più actionable.
- **Problema risolto**: F-23.
- **Rischio**: basso. **Stato**: DA FARE.
- **Commit suggerito**: `fix(ux): improve fallback error messages in shuttle schedules page`

### M1.5-07 — Errore su DELETE non deve sostituire l'intera pagina
- **File consentiti**: `app/(app)/settings/shuttles/page.tsx`.
- **Modifiche**: usare un banner/stato locale invece dello stato globale `error` a piena pagina per gli errori di cancellazione.
- **Problema risolto**: F-24.
- **DoD**: un errore di delete non nasconde le altre navette funzionanti.
- **Rischio**: basso. **Stato**: DA FARE.
- **Commit suggerito**: `fix(ux): scope delete error to a local banner instead of full-page error`

---

## MILESTONE 2 — Post-stagione (interventi strutturali)

| Codice | Descrizione | Risolve | Note |
|---|---|---|---|
| M2-01 | Introdurre tabella `shuttle_schedules` reale con id stabile, FK verso `services` | F-01, F-02, F-06, F-08, F-09, F-15 | Richiede migrazione + backfill dai dati derivati esistenti; da pianificare con test estesi fuori stagione |
| M2-02 | Funzione RPC transazionale per update/delete di uno schedule (BEGIN…COMMIT) | F-01, F-03 | Dipende da M2-01 |
| M2-03 | UPSERT per data invece di delete globale, preservando `assignments`/`status_events` | F-01 | Dipende da M2-01/M2-02 |
| M2-04 | Indice `UNIQUE` parziale per idempotenza creazione | F-08 | Dipende da M2-01 |
| M2-05 | Indice dedicato su colonne usate da `deleteMatchingFutureServices` | F-16 | Indipendente, ma da rivalutare se M2-01 cambia lo schema |
| M2-06 | Rimuovere fallback di classificazione via `vessel` testuale, rendere `booking_service_kind` obbligatorio | F-13 | Richiede verifica dati storici pre-migrazione |
| M2-07 | Unificare `buildRows`/`buildServiceRows` e chunking insert in `lib/shuttle-schedules.ts` | F-14 | Refactoring puro, basso rischio ma da fare fuori stagione per policy |
| M2-08 | Rimuovere codice morto (`isShuttleLikeService`, `resolveShuttleHotelName` se non riutilizzati) | F-26 | — |
| M2-09 | Documentare `docs/shuttle-module.md` (architettura reale) | F-25 | Consigliato come primo task di M2, a costo quasi zero |
| M2-10 | Rivalutare posizione voce di menu "Navette" | F-27 | Solo se richiesto da feedback operatori |
| M2-11 | Lock ottimistico o `SELECT … FOR UPDATE` per concorrenza tra operatori | F-09 | Dipende da M2-01 |
| M2-12 | Riordinare `DAYS_LABEL`/UI giorni settimana Lun→Dom con attenzione agli indici sottostanti | F-20 (parte strutturale) | Richiede test approfonditi su `enumerateShuttleDates` |
| M2-13 | Test E2E Playwright per il flusso completo navette | audit — test mancanti | Da aggiungere a `tests/e2e/`, eseguibile con `pnpm e2e:ops` |
| M2-14 | Test unitari mancanti: GET/POST/DELETE, ruoli/autorizzazione, sovrapposizione intervalli | audit — test mancanti | Indipendenti tra loro, possono precedere M2-01 |

---

## Ordine di esecuzione consigliato

**Milestone 1** (in questo ordine, ciascuno testato e committato separatamente):
M1-03 → M1-02 → M1-08 → M1-06+M1-09 → M1-07 → M1-05 → M1-01 → M1-04

Motivazione ordine: si parte dai task a rischio zero (solo test, M1-03), poi fix puntuali isolati (data/log/errori, M1-02/M1-08/M1-06/M1-09/M1-07/M1-05) prima di toccare la UI con l'avviso bloccante (M1-01, dipende da un nuovo endpoint) e infine il cambio di query più delicato (M1-04, da fare con più margine di osservazione).

**Milestone 1.5**: nessuna dipendenza dall'ordine, eseguibili in parallelo da persone diverse; consigliato M1.5-01 e M1.5-03 per primi (rischio operativo più alto se non fatti).

**Milestone 2**: M2-09 (documentazione) può partire subito senza rischio. M2-01 è il prerequisito di gran parte degli altri task strutturali e va pianificato con un progetto dedicato fuori stagione.

## Definition of Done del modulo (criterio per dichiararlo concluso)

Il modulo Navette si considera "in sicurezza per l'alta stagione" quando: tutti i task Milestone 1 sono COMPLETATI e testati in produzione senza regressioni per almeno una settimana; il finding F-01 ha almeno la mitigazione M1-01 attiva; nessun finding CRITICA residuo nell'audit. Si considera "strutturalmente sano" solo dopo il completamento di M2-01/M2-02/M2-03 post-stagione.

## Rollback generale

Ogni task di questa checklist è pensato per un singolo commit isolato: il rollback standard è `git revert <commit>` sul commit del task. Nessun task di Milestone 1 tocca lo schema DB, quindi nessun rollback richiede interventi manuali sul database.
