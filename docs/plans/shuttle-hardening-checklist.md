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
| DONE-05 | Blocco server-side (HTTP 409, fail-closed) di PATCH/DELETE su navette con corse odierne/future già assegnate (`assignments`) o con `status != 'new'` — mitigazione di F-01, verificato tenant-scoped su `services` e `assignments` | `ac37474` (2026-07-31) | `tests/unit/shuttle-schedules-operational-guard.test.ts` (13 casi: blocco/non blocco, oggi incluso, passato escluso, tenant isolation, fail-closed su errore query) |
| DONE-06 | Verifica server-side (HTTP 400, fail-closed) che `hotel_id` in POST/PATCH appartenga al tenant autenticato (`public.hotels` filtrato per `id` + `tenant_id`) — mitigazione di **F-10**, guard eseguito prima del guard F-01 e prima di ogni scrittura, verificato ordine e tenant isolation | `b909349` (2026-07-31) | `tests/unit/shuttle-schedules-hotel-tenant-guard.test.ts` (12 casi: tenant proprio/altrui, hotel_id null/omesso, fail-closed su errore query, ordine rispetto al guard F-01); reviewer indipendente: **APPROVATO** |
| DONE-07 | Rimozione dei messaggi Postgres/Supabase grezzi dalle risposte 500 di `GET`/`POST`/`PATCH`/`DELETE` — mitigazione di **F-11**; ogni errore interno inatteso viene ora loggato lato server via `auditLog` (`lib/server/ops-audit.ts`, già in uso nello stesso flusso di autenticazione) con dettaglio completo (`tenantId`, `userId`, `scheduleId` quando disponibile, messaggio originale), mentre il client riceve solo un messaggio generico stabile; status HTTP invariati; aggiunto log anche sui due catch dell'hotel-check F-10, in precedenza privi di log | `eb4f978` (2026-07-31) | `tests/unit/shuttle-schedules-error-sanitization.test.ts` (10 casi: 4 percorsi × assenza leak/log presente, assenza campi `details/hint/code/stack`, regressione 400/409/200 invariati); reviewer indipendente: **APPROVATO** |
| DONE-08 | `todayIsoDate()` calcola "oggi" esplicitamente in `Europe/Rome` (`Intl.DateTimeFormat("en-CA", {timeZone:"Europe/Rome"})`), non più in UTC — mitigazione di **F-05**; firma testabile `todayIsoDate(now = new Date())`; nessun offset fisso, DST gestita automaticamente | `988cf4b` (2026-07-31) | `tests/unit/shuttle-schedules-rome-date.test.ts` (22 casi: transizioni DST marzo/ottobre, rollover fine anno/mese, indipendenza dal TZ di processo, valore effettivo passato a `.gte("date",...)` a livello handler); reviewer indipendente: **APPROVATO** |
| DONE-09 | `decodeShuttleScheduleId(id)` nel PATCH avvolta in try/catch + validazione minima della struttura decodificata (campi indispensabili alle query: `direction`, `departure_time`, `customer_name`, `vessel`) — mitigazione di **F-12**; id malformato o strutturalmente incompleto → `400 "Identificativo navetta non valido."`, nessuna query/scrittura eseguita | `d687bd0` (2026-07-31) | `tests/unit/shuttle-schedules-invalid-id.test.ts` (13 casi: base64/JSON invalido, oggetto vuoto/array/campi mancanti/tipi errati, campi extra accettati, id valido invariato, nessun leak, regressione 401/409/400); reviewer indipendente: **APPROVATO** |
| DONE-10 | Copertura test handler-level dell'isolamento tenant su `GET`/`POST`/`PATCH`/`DELETE` di `shuttle-schedules` — **F-07**; verificato con mock tenant-aware mutabile (non tautologico: dimostrato che i test falliscono realmente rimuovendo un filtro `.eq("tenant_id",...)` critico, poi ripristinato) che **nessuna vulnerabilità è stata trovata** — l'isolamento era già corretto per costruzione indipendente (tenant_id sempre da `auth.membership.tenant_id`, mai dal body né dall'id derivato); **nessun codice di produzione modificato** | nessuno (solo test, commit da effettuare) | `tests/unit/shuttle-schedules-tenant-isolation.test.ts` (28 casi: GET/POST/PATCH/DELETE, chiave identica tra tenant, `tenant_id` malevolo nel body, hotel cross-tenant, auth/ruoli, regressioni F-01/F-10/F-11/M1-02/M1-07); reviewer indipendente: **APPROVATO** |
| DONE-11 | Audit persistente e aggregato delle operazioni massive su `shuttle-schedules` — **F-04, ridefinita**; un evento `auditLog` (`shuttle_schedule_created`/`_updated`/`_deleted`, livello `info`) per ogni POST/PATCH/DELETE riuscito, scritto **solo dopo il successo completo** dell'operazione, con `previous`/`next` (chiave funzionale + periodo + giorni, camelCase), `deletedCount`/`insertedCount`/`deletedDateFrom`/`deletedDateTo`; riusa `ops_audit_events` (già esistente, già consultabile via `/api/audit/feed` e pagina `/audit`, **non modificate**), **nessun log per singola riga `services`**, **nessuna migrazione**; il guard F-01 (`hasOperationalFutureServices`) è stato esteso a restituire anche `matchedCount`/`dateFrom`/`dateTo`/`weekdays` (stessa query, stessa logica di blocco, nessun comportamento esterno cambiato) per evitare una seconda select ridondante; il fallimento parziale del PATCH (DELETE riuscita, INSERT fallito) è ora riconoscibile nell'evento di errore esistente tramite `deletePhaseCompleted`/`deletedCount`/`expectedInsertCount`, senza introdurre transazionalità | nessuno (solo codice+test, commit applicativo da effettuare) | `tests/unit/shuttle-schedules-audit-log.test.ts` (33 casi: POST/PATCH/DELETE, diff previous/next, conteggi/range reali, fallimento parziale, tenant isolation, privacy); esperimento di sensibilità eseguito (rimozione temporanea della chiamata di successo → 7 test falliscono realmente, poi ripristinato, `git diff` verificato pulito); reviewer indipendente: **APPROVATO** |

Nota: DONE-01 non copre `app/api/shuttle-schedules/**`, che però risulta tenant-safe per costruzione indipendente (vedi F-07 nell'audit). Il task M1-03 sotto copre solo il gap di test, non un bug.

Nota su DONE-05: l'implementazione sostituisce integralmente l'approccio pianificato in M1-01 (avviso "soft" in UI con `confirm()`, task ora chiuso di conseguenza — vedi sotto). Il blocco è **hard** lato server: nessun percorso applicativo può eseguire il delete quando esistono corse operative, indipendentemente dalla UI. La causa strutturale (F-01, modello delete+insert) resta comunque aperta e rimandata a Milestone 2 (M2-01/M2-02/M2-03): DONE-05 impedisce la perdita di dati, non elimina il modello a rischio.

---

## MILESTONE 1 — Alta stagione (correzioni sicure, atomiche, basso rischio)

### M1-01 — ~~Avviso bloccante in UI prima di modificare/eliminare navette con corse future già assegnate~~ → SUPERATO da DONE-05
- **Milestone**: 1 · **Priorità**: MASSIMA (mitiga F-01, CRITICA)
- **Stato**: **COMPLETATO (in forma più forte del previsto)** — commit `ac37474` (2026-07-31). Vedi DONE-05 sopra.
- **Nota**: il piano originale prevedeva un avviso "soft" in UI (endpoint di conteggio + `confirm()` con possibilità di procedere). L'implementazione effettiva è un **blocco hard lato server** (HTTP 409, nessun percorso per "continuare comunque"): copre lo stesso obiettivo (impedire perdita di assegnazioni/stato) in modo più robusto, perché non dipende dalla UI né da un client che rispetti l'avviso. Questo task non richiede ulteriore lavoro applicativo.
- **Follow-up eventuale (Milestone 1.5, non urgente)**: `page.tsx` (`handleSave`/`handleDelete`) mostra oggi all'operatore il campo `error` grezzo della risposta (`"SHUTTLE_HAS_OPERATIONAL_SERVICES"`, il codice macchina) invece del campo `message` leggibile restituito dal nuovo blocco. Non è un rischio di perdita dati (il blocco funziona comunque), solo un difetto di leggibilità del messaggio d'errore — candidabile come nuovo task UX in Milestone 1.5, non trattato in questa sessione.

### M1-02 — Fix `todayIsoDate()` per usare il fuso Europe/Rome invece di UTC
- **Milestone**: 1 · **Priorità**: ALTA (F-05)
- **Stato**: **COMPLETATO** — commit `988cf4b` (2026-07-31). Vedi DONE-08 sopra.
- **Risultato sintetico**: `todayIsoDate(now = new Date())` in entrambi i file usa `Intl.DateTimeFormat("en-CA", {timeZone:"Europe/Rome"})`; nessun offset fisso, DST gestita automaticamente, indipendente dal timezone del processo (verificato con `TZ` diverse).
- **Test eseguiti**: `tests/unit/shuttle-schedules-rome-date.test.ts` (22/22 verdi) + suite shuttle esistente (88/88 verdi) + `pnpm typecheck` pulito + lint pulito.
- **Reviewer indipendente**: **APPROVATO**.

### M1-03 — Test di tenant isolation dedicato per `shuttle-schedules`
- **Milestone**: 1 · **Priorità**: ALTA (F-07)
- **Stato**: **COMPLETATO** — solo test, nessun commit di codice (nessuna vulnerabilità trovata). Vedi DONE-10 sopra.
- **Risultato sintetico**: 28 test handler-level con mock tenant-aware mutabile (non tautologico — dimostrato rimuovendo temporaneamente `.eq("tenant_id",...)` da `deleteMatchingFutureServices` e osservando 5 fallimenti reali, poi ripristinato). **Nessuna vulnerabilità cross-tenant trovata**: GET/POST/PATCH/DELETE risultano tutti correttamente tenant-scoped, `tenant_id` nel body viene sempre ignorato, chiavi identiche tra tenant non causano fusione né cancellazione cross-tenant, hotel cross-tenant resta bloccato da F-10.
- **Test eseguiti**: `tests/unit/shuttle-schedules-tenant-isolation.test.ts` (28/28 verdi) + suite shuttle esistente (129/129 verdi) + `pnpm typecheck` pulito + lint pulito.
- **Reviewer indipendente**: **APPROVATO**.

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
- **Stato**: **COMPLETATO** — commit `b909349` (2026-07-31). Vedi DONE-06 sopra.
- **Risultato sintetico**: helper `isHotelInTenant(admin, tenantId, hotelId)` aggiunto in entrambe le route (`route.ts` e `[id]/route.ts`, duplicato minimo perché `lib/shuttle-schedules.ts` è fuori perimetro); eseguito solo se `hotel_id` è presente e non nullo, prima di qualunque scrittura e, nel PATCH, prima del guard F-01 (`hasOperationalFutureServices`); su mismatch tenant risponde `400 INVALID_HOTEL_FOR_TENANT`; su errore query risponde `500` fail-closed senza dettagli Postgres.
- **Test eseguiti**: `tests/unit/shuttle-schedules-hotel-tenant-guard.test.ts` (12/12 verdi) + suite shuttle esistente (56/56 verdi, nessun mock esistente modificato) + `pnpm typecheck` pulito + lint pulito sui file toccati.
- **Reviewer indipendente**: **APPROVATO** — verificato ordine dei controlli, tenant isolation, fail-closed, nessun file vietato toccato, WhatsApp intatto.

### M1-06 — Sanificare i messaggi di errore restituiti al client
- **Milestone**: 1 · **Priorità**: MEDIA (F-11)
- **Stato**: **COMPLETATO** — commit `eb4f978` (2026-07-31). Vedi DONE-07 sopra.
- **Risultato sintetico**: rimossi i 4 punti di esposizione (`GET`, `POST`, `PATCH`, `DELETE`) più 2 punti aggiuntivi privi di log trovati durante l'audit mirato (i catch dell'hotel-check F-10, già generici ma senza log); ogni errore è ora loggato via `auditLog` con dettaglio completo lato server, il client riceve solo messaggi generici stabili (`"Impossibile recuperare/creare/aggiornare/eliminare la navetta."`); status HTTP invariati.
- **Test eseguiti**: `tests/unit/shuttle-schedules-error-sanitization.test.ts` (10/10 verdi, incluse 4 regressioni esplicite su 400/409/200) + suite shuttle esistente (66/66 verdi, nessun mock modificato) + `pnpm typecheck` pulito + lint pulito.
- **Reviewer indipendente**: **APPROVATO** — verificata assenza di `error.message`/`details`/`hint`/`code`/`stack` in tutte le risposte, presenza del log su tutti i percorsi, nessuna regressione su F-01/F-10, nessun file vietato toccato, WhatsApp intatto.

### M1-07 — `decodeShuttleScheduleId` dentro try/catch nel PATCH
- **Milestone**: 1 · **Priorità**: BASSA (F-12)
- **Stato**: **COMPLETATO** — commit `d687bd0` (2026-07-31). Vedi DONE-09 sopra.
- **Risultato sintetico**: decode avvolto in try/catch + validazione minima post-decode dei soli campi indispensabili alle query; `400 "Identificativo navetta non valido."` su id malformato o strutturalmente incompleto, nessuna query/scrittura eseguita.
- **Test eseguiti**: `tests/unit/shuttle-schedules-invalid-id.test.ts` (13/13 verdi) + suite shuttle esistente (101/101 verdi) + `pnpm typecheck` pulito + lint pulito.
- **Reviewer indipendente**: **APPROVATO**.

### M1-08 — Log di audit per cancellazione navetta
- **Milestone**: 1 · **Priorità**: ALTA (F-04)
- **Stato**: **COMPLETATO** — codice e test pronti, commit applicativo da effettuare. Vedi DONE-11 sopra.
- **Risultato sintetico**: audit aggregato per azione funzionale (creazione/modifica/eliminazione), non log tecnico riga-per-riga. Riusa `ops_audit_events` tramite `auditLog()` già in uso nel file — nessuna nuova tabella, nessuna migrazione. `service_deletion_log` **non** è stato usato per queste operazioni bulk (resta dedicato alla cancellazione di singolo servizio via `ops/services/[id]`, invariato).
- **Limite transazionale residuo**: PATCH resta non transazionale (delete e insert sono due chiamate Supabase separate, invariato da prima di questo task). In caso di fallimento tra le due, nessun evento di successo viene scritto; l'evento di errore esistente (M1-06) è arricchito con `deletePhaseCompleted` per distinguere un fallimento prima della cancellazione da uno dopo (dati potenzialmente in stato parziale, non ripristinati automaticamente — nessun rollback introdotto, per esplicito vincolo del task).
- **Test eseguiti**: `tests/unit/shuttle-schedules-audit-log.test.ts` (33/33 verdi) + suite shuttle esistente (162/162 verdi) + `pnpm typecheck` pulito + lint pulito + esperimento di sensibilità (rimozione temporanea della chiamata di successo → 7 test falliti realmente, ripristinato, `git diff` verificato pulito).
- **Reviewer indipendente**: **APPROVATO** — verificato racconto funzionale (non solo DELETE SQL), nessun nuovo modello dati, nessun dato personale superfluo, volume proporzionato (un evento per azione), PATCH/DELETE distinti, scrittura solo dopo successo reale, F-01/F-10/F-11/M1-02/M1-07/F-07 invariati, WhatsApp non toccato.

### M1-09 — Log degli errori di scrittura (PATCH/POST/DELETE)
- **Milestone**: 1 · **Priorità**: MEDIA (F-17)
- **Stato**: **GIÀ COPERTO da DONE-07 (M1-06, commit `eb4f978`)** — nessun lavoro residuo.
- **Nota**: l'implementazione di M1-06 (sanificazione errori) ha aggiunto `auditLog` a **tutti** i blocchi `catch` di `GET`/`POST`/`PATCH`/`DELETE` in entrambi i file (verificato con `grep` mirato: ogni `catch` è seguito da una chiamata `auditLog`), esattamente l'obiettivo di questo task. Nessun blocco `catch` privo di log risulta più presente. Task chiuso senza ulteriore commit.

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

**Milestone 1** — stato aggiornato al 2026-07-31 dopo l'audit aggregato delle operazioni massive (DONE-11):
~~M1-03~~ (DONE-10) → ~~M1-01~~ (DONE-05) → ~~M1-05~~ (DONE-06) → ~~M1-06~~ (DONE-07) → ~~M1-02~~ (DONE-08) → ~~M1-07~~ (DONE-09) → ~~M1-09~~ (già coperto da DONE-07) → ~~M1-08~~ (DONE-11) → **M1-04** (unico task M1 ancora aperto)

**M1-04 (filtro/performance GET, F-06) è l'unico task ancora aperto in Milestone 1.** Nessuna migrazione richiesta, ma **rischio di regressione medio** (cambia cosa il GET restituisce, richiede feature flag e verifica manuale attenta prima del deploy in stagione). **Non iniziato in questa sessione**, per istruzione esplicita.

**Milestone 1.5**: nessuna dipendenza dall'ordine, eseguibili in parallelo da persone diverse; consigliato M1.5-01 e M1.5-03 per primi (rischio operativo più alto se non fatti).

**Milestone 2**: M2-09 (documentazione) può partire subito senza rischio. M2-01 è il prerequisito di gran parte degli altri task strutturali e va pianificato con un progetto dedicato fuori stagione.

## Definition of Done del modulo (criterio per dichiararlo concluso)

Il modulo Navette si considera "in sicurezza per l'alta stagione" quando: tutti i task Milestone 1 sono COMPLETATI e testati in produzione senza regressioni per almeno una settimana; il finding F-01 ha almeno la mitigazione M1-01 attiva; nessun finding CRITICA residuo nell'audit. Si considera "strutturalmente sano" solo dopo il completamento di M2-01/M2-02/M2-03 post-stagione.

## Rollback generale

Ogni task di questa checklist è pensato per un singolo commit isolato: il rollback standard è `git revert <commit>` sul commit del task. Nessun task di Milestone 1 tocca lo schema DB, quindi nessun rollback richiede interventi manuali sul database.
