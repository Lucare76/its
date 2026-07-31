# Audit modulo Navette (shuttle) — ITS

- **Data audit**: 2026-07-31
- **Branch**: main
- **HEAD al momento dell'audit**: `db71eaf` (allineato con `origin/main`)
- **Worktree iniziale**: pulito (verificato con `git status --short`)
- **Modalità**: audit READ-ONLY, nessun file applicativo modificato, nessun test modificato, nessuna migrazione creata/eseguita
- **Vincolo rispettato**: WhatsApp (template, webhook Meta, invii, convocazioni) NON è stato toccato né analizzato in profondità

## Executive summary

Il modulo "Navette" **non ha una tabella dedicata** in Supabase. Non esiste alcuna `shuttle_schedules` nello schema: ogni "orario navetta" mostrato in `app/(app)/settings/shuttles/page.tsx` è un raggruppamento **calcolato a runtime** dalle righe della tabella `public.services` (la stessa tabella usata per transfer, escursioni, bus tour), tramite `deriveShuttleSchedules()` in `lib/shuttle-schedules.ts`. L'"id" di una navetta è il base64url di 7 campi (`hotel_id, booking_service_kind, customer_name, direction, departure_time, meeting_point, vessel`), non una chiave primaria di riga.

Da questa scelta architetturale derivano quasi tutti i finding di severità CRITICA/ALTA:

1. **Modificare una navetta (PATCH) cancella e ricrea tutte le righe `services` future corrispondenti.** Poiché `assignments.service_id` e `status_events.service_id` hanno `ON DELETE CASCADE` verso `services`, ogni assegnazione autista/veicolo e ogni evento di stato su corse future già pianificate **viene perso** al primo salvataggio, anche per una modifica banale (es. correzione di una nota). Le righe vengono ricreate con `pax:1`, `phone:""`, `status:"new"` — dati inseriti manualmente dagli operatori vengono azzerati silenziosamente. **Questo è il rischio più grave del modulo in alta stagione.**
2. L'operazione di cancellazione+ricreazione non è transazionale: un errore a metà lascia la navetta "scomparsa" dal piano finché non si interviene manualmente.
3. Due navette create con gli stessi 7 campi identificativi ma periodi di validità diversi vengono **fuse in un'unica scheda** in UI; un edit su quella scheda può sovrascrivere anche il periodo che l'operatore non intendeva toccare.
4. La query `GET` scarica **l'intera storia** dei servizi del tenant (nessun filtro su data o tipo servizio) per ricostruire le navette — costo crescente con l'accumulo di dati stagionali, e causa anche di un bug di correttezza (il "valid_from" mostrato può risalire a stagioni precedenti se esiste una vecchia navetta con la stessa chiave).
5. Il calcolo "oggi" (`todayIsoDate()`) usa `Date.toISOString()`, cioè **UTC**, non il fuso `Europe/Rome`: nella finestra 00:00–02:00 ora italiana (CEST), una data già iniziata in Italia può ancora essere considerata "futura" (quindi cancellabile/rigenerabile).

Sul fronte sicurezza e autorizzazione il modulo è invece **solido**: tutte le route richiedono autenticazione (`authorizeServiceRoleRequest`), il `tenant_id` non è mai accettato da input client e viene sempre derivato dalla sessione, e non è stato trovato alcun IDOR sfruttabile. Il commit `df0cc44` ("fix: enforce tenant isolation in ops routes") **non copre** le route `app/api/shuttle-schedules/**` (tocca solo `app/api/ops/escursioni` e `app/api/ops/pickup-runs`), ma il codice risulta comunque tenant-safe per costruzione indipendente — verificato riga per riga.

I 4 commit già completati (tenant isolation ops routes, `valid_from`/`valid_to` obbligatori nel PATCH, regressione range date) sono confermati corretti e non vengono reintrodotti come task.

## Perimetro

File analizzati (elenco esatto):
- `app/(app)/settings/shuttles/page.tsx` — UI gestione navette
- `app/api/shuttle-schedules/route.ts` — GET (lista), POST (creazione)
- `app/api/shuttle-schedules/[id]/route.ts` — PATCH (modifica), DELETE (cancellazione)
- `lib/shuttle-schedules.ts` — derivazione/encoding schedule, enumerazione date
- `lib/server/fetch-all-services.ts` — fetch paginato usato dal GET
- `lib/server/pricing-auth.ts` — pattern di autorizzazione
- `lib/piano-shuttle-pair.ts` e `lib/piano-real-giro-diagnostics.ts` — integrazione col piano giorno (verificato: nessun accoppiamento tecnico diretto con `lib/shuttle-schedules.ts`, solo affinità semantica sul nome "navetta")
- `lib/app-shell-nav.tsx` — voce di menu
- `supabase/migrations/0001_schema.sql`, `0019_agency_booking_module.sql`, `0060_services_hotel_id_nullable.sql`, `0163`–`0188_*navetta*.sql`, `0165_fix_booking_service_kind_constraint.sql`
- `tests/unit/shuttle-schedules-patch-date-range.test.ts`, `-valid-from.test.ts`, `-valid-to.test.ts`, `tests/unit/piano-shuttle-pair.test.ts`
- `docs/shuttle-module.md` (trovato vuoto, 0 byte)
- `scripts/audit-navette-operative.ts` (script di verifica manuale già esistente)

Esplicitamente escluso dal perimetro: tutto ciò che riguarda WhatsApp (`lib/server/whatsapp*`, webhook Meta, invii/convocazioni).

## Metodologia

Sei sub-agenti specializzati, in modalità strettamente read-only, hanno analizzato in parallelo: architettura, database/integrità dati, API/autenticazione/sicurezza, logica operativa (seguendo il flusso reale del codice, non solo i nomi delle funzioni), UI/UX, test/performance/manutenibilità. L'agente principale ha poi svolto il ruolo di reviewer indipendente: ha riletto direttamente i file sorgente citati (`app/api/shuttle-schedules/[id]/route.ts`, `app/api/shuttle-schedules/route.ts`, `lib/shuttle-schedules.ts`, `supabase/migrations/0001_schema.sql`), verificato i numeri di riga, confermato con `git show --stat df0cc44` l'effettivo perimetro del fix di tenant isolation già mergeato, deduplicato i finding riportati da più agenti sullo stesso problema e scartato le ipotesi non supportate da evidenza diretta nel codice.

## Mappa e flusso del modulo

```
UI: app/(app)/settings/shuttles/page.tsx
  → GET  /api/shuttle-schedules            (lista, derivata da services)
  → POST /api/shuttle-schedules            (crea N righe services, una per data)
  → PATCH /api/shuttle-schedules/[id]      (cancella righe future + ricrea)
  → DELETE /api/shuttle-schedules/[id]     (cancella righe future)

app/api/shuttle-schedules/route.ts
  → authorizeServiceRoleRequest(["admin","operator"])
  → fetchAllServices(admin, tenant_id)      [lib/server/fetch-all-services.ts — select("*"), nessun filtro data/kind]
  → deriveShuttleSchedules(services)        [lib/shuttle-schedules.ts — raggruppamento in memoria]

app/api/shuttle-schedules/[id]/route.ts
  → decodeShuttleScheduleId(id)             [base64url → 7 campi chiave, NON una FK]
  → deleteMatchingFutureServices(...)        DELETE FROM services WHERE tenant_id=... AND date>=oggi AND <7 campi match>
  → insertRows(...)                          INSERT nuove righe (pax:1, phone:"", status:"new")

DB: public.services
  → assignments.service_id   ON DELETE CASCADE
  → status_events.service_id ON DELETE CASCADE
  → whatsapp_events.service_id ON DELETE SET NULL
  → hotel_id → hotels(id) ON DELETE RESTRICT (nessuna verifica di tenant lato applicativo)
```

Nessuna tabella `shuttle_schedules`, nessuna FK dedicata, nessun CHECK su range date a livello DB (solo validazione applicativa Zod), nessun indice dedicato alla combinazione di campi usata da `deleteMatchingFutureServices` (l'unico indice pertinente è `idx_services_booking_kind_date (tenant_id, booking_service_kind, date, time)`, non sfruttato dal GET perché la query non filtra su `booking_service_kind`).

## Finding — ordinati per severità

Legenda stato: **BUG CONFERMATO** (verificato leggendo il codice), **RISCHIO CONCRETO** (verificato ma richiede condizioni specifiche in produzione per manifestarsi), **DEBITO TECNICO**, **TEST MANCANTE**, **UX**, **PERFORMANCE**.

### CRITICA

**F-01 — PATCH/DELETE navetta cancella a cascata assegnazioni driver/veicolo e stato delle corse future**
Stato: BUG CONFERMATO · Verificato da 3 agenti indipendenti (architettura, logica operativa, database) + rilettura diretta.
Evidenza:
- `app/api/shuttle-schedules/[id]/route.ts:132-137` — PATCH chiama sempre `deleteMatchingFutureServices` poi `insertRows`, indipendentemente da cosa è cambiato.
- `app/api/shuttle-schedules/[id]/route.ts:59-85` — `deleteMatchingFutureServices` cancella ogni riga `services` con `date >= oggi` che matcha i 7 campi, senza guardare `status`/presenza di `assignments`.
- `app/api/shuttle-schedules/[id]/route.ts:31-49` (`buildRows`) — le righe ricreate hanno sempre `pax: 1, phone: "", status: "new"`, perdendo qualunque valore personalizzato in precedenza.
- `supabase/migrations/0001_schema.sql:65,74` — `assignments.service_id` e `status_events.service_id` sono `references public.services (id) on delete cascade`: la cancellazione di una riga `services` elimina automaticamente le relative assegnazioni autista/veicolo e la cronologia di stato.
- `app/(app)/settings/shuttles/page.tsx:250` (circa) — il testo mostrato all'operatore ("Ogni modifica aggiorna anche le corse future collegate") non comunica la reale portata dell'operazione (perdita di assegnazioni e stato).

Scenario riproducibile: un operatore assegna un autista/veicolo a una corsa navetta di domani (via piano giorno). Un secondo operatore corregge un refuso nel campo Note della stessa navetta in Settings → Navette e salva. Il PATCH cancella tutte le righe `services` future con quella identità (inclusa quella appena assegnata) e le ricrea da zero: l'assegnazione sparisce, lo stato torna "new", pax torna a 1, telefono si svuota.

Impatto: perdita silenziosa di dati operativi critici in produzione durante l'alta stagione; nessun avviso all'utente; nessuna eccezione sollevata (l'operazione "riesce" con 200 OK).

Probabilità: alta — qualunque modifica a un campo qualsiasi di una navetta con corse future già gestite (assegnate, con pax reali) attiva il comportamento.

Soluzione raccomandata: non eseguire delete+insert incondizionato; distinguere le righe già "lavorate" (status ≠ 'new' o con assignment esistente) da quelle ancora vergini, aggiornando le prime con `UPDATE` mirato sui soli campi cambiati e limitando delete+insert alle sole righe non ancora toccate da un operatore.

Soluzione minima sicura per alta stagione: avviso bloccante in UI prima del salvataggio ("Questa modifica riguarda N corse future, di cui M già assegnate a un autista: le assegnazioni verranno perse. Continuare?"), calcolato con una query di sola lettura prima del PATCH. Non cambia la logica di backend, riduce il rischio di modifica involontaria.

Soluzione strutturale post-stagione: tabella `shuttle_schedules` reale con id stabile, generazione delle occorrenze `services` come UPSERT per data (non delete globale), preservando `assignments`/`status_events` per le righe non toccate.

Test necessari: test che verifichi che un PATCH che non cambia la chiave di raggruppamento non cancelli righe con `status != 'new'` o con assignment esistente (da scrivere solo dopo l'implementazione del fix, non prima — il comportamento attuale è quello da correggere).

Rischio regressione del fix: alto se implementato in fretta (tocca il cuore della logica di scrittura) — per questo in Milestone 1 si raccomanda solo l'avviso UI, non la riscrittura della logica di delete/insert.

---

**F-02 — Merge implicito di periodi di validità distinti nella stessa scheda navetta**
Stato: RISCHIO CONCRETO · Verificato da 2 agenti (architettura, logica operativa).
Evidenza: `lib/shuttle-schedules.ts:74-118` (`deriveShuttleSchedules`) raggruppa per chiave che **non include** `valid_from`/`valid_to`/`days_of_week`. Se in `services` esistono righe con la stessa identità (hotel/direzione/orario/…) ma create in momenti diversi per periodi non contigui, vengono fuse in un'unica scheda con `valid_from`/`valid_to` estesi al min/max e `days_of_week` unito (righe 114-118).

Scenario riproducibile: navetta Hotel X ore 08:30 creata per aprile-giugno (Lun-Ven), poi una seconda voce creata per agosto-settembre con stessi hotel/orario/direzione ma giorni diversi. La UI mostra **una sola** riga con badge di validità aprile→settembre. Un PATCH su quella riga (es. per correggere solo agosto-settembre) sostituisce l'intero periodo con un unico nuovo intervallo, alterando/eliminando anche il periodo aprile-giugno se ancora futuro.

Impatto: possibile alterazione o cancellazione non intenzionale di un periodo che l'operatore non stava modificando.

Soluzione minima sicura per alta stagione: nessuna modifica di codice a rischio zero disponibile; mitigazione operativa (comunicare agli operatori di non ricreare navette con identici 7 campi per periodi diversi, variare almeno un campo).

Soluzione strutturale post-stagione: id stabile con range di validità come colonna propria (Finding F-01 risolve anche questo).

---

### ALTA

**F-03 — Delete e insert non transazionali: finestra di "navetta scomparsa" in caso di errore parziale**
Stato: RISCHIO CONCRETO · Confermato da 2 agenti (database, test/performance).
Evidenza: `app/api/shuttle-schedules/[id]/route.ts:132-137` — `deleteMatchingFutureServices` e `insertRows` sono due chiamate PostgREST separate, non in transazione DB. `insertRows` (righe 51-57) chunka a 500 righe; un errore in un chunk intermedio lancia un'eccezione dopo che il delete è già avvenuto.
Scenario: PATCH su una navetta con molte date future; il delete riesce, l'insert fallisce a metà (errore di rete/constraint) → la navetta risulta assente dal piano fino a intervento manuale, con risposta 500 al client ma nessun rollback automatico.
Impatto: interruzione silenziosa del servizio per una navetta in alta stagione.
Soluzione minima sicura: invertire l'ordine delle operazioni (insert delle nuove righe prima, delete delle vecchie righe non più valide dopo) così un fallimento lascia al più righe duplicate temporaneamente, mai un vuoto totale.
Soluzione strutturale: funzione RPC Postgres transazionale (`BEGIN…COMMIT`) per l'intera operazione.

---

**F-04 — Cancellazione navetta non registrata in `service_deletion_log`**
Stato: BUG CONFERMATO (per confronto diretto col pattern usato altrove nel progetto).
Evidenza: `app/api/ops/services/[id]/route.ts` scrive su `service_deletion_log` prima di ogni DELETE di un singolo servizio; `app/api/shuttle-schedules/[id]/route.ts:148-170` (DELETE navetta) non lo fa — chiama solo `deleteMatchingFutureServices`, eliminando potenzialmente decine di righe future senza lasciare traccia di chi/quando/perché.
Impatto: nessuna possibilità di audit/contestazione in caso di corsa navetta mancante segnalata da un hotel.
Soluzione minima sicura: aggiungere una insert (anche aggregata) su `service_deletion_log` prima della delete, riusando il pattern esistente.
Soluzione strutturale: funzione di libreria condivisa per la cancellazione di servizi, usata da entrambe le rotte.

---

**F-05 — `todayIsoDate()` calcola "oggi" in UTC, non in Europe/Rome**
Stato: BUG CONFERMATO.
Evidenza: `app/api/shuttle-schedules/[id]/route.ts:23-25` e `app/api/shuttle-schedules/route.ts:26-28`, definizione duplicata identica: `new Date().toISOString().slice(0,10)`. In estate (CEST = UTC+2), tra le 00:00 e le 02:00 ora italiana l'orologio UTC è ancora sul giorno precedente.
Scenario: un'operazione PATCH/DELETE eseguita in quella finestra usa come cutoff "futuro" una data che in Italia è già iniziata, includendo nel delete/rigenerazione corse del giorno corrente invece di sole corse realmente future.
Impatto: combinato con F-01, aumenta la finestra di rischio di perdita dati per operazioni notturne/mattutine.
Soluzione minima sicura: sostituire il calcolo con una versione esplicita in fuso `Europe/Rome` (es. `Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Rome'})`), stessa modifica in entrambi i file.
Soluzione strutturale: centralizzare in `lib/server/date.ts` una singola utility riusata ovunque.

---

**F-06 — `GET /api/shuttle-schedules` scarica l'intera storia di `services` del tenant**
Stato: BUG CONFERMATO (correttezza) + PERFORMANCE. Confermato da 4 agenti (architettura, database, operativo, test/performance).
Evidenza: `lib/server/fetch-all-services.ts` fa `select("*")` filtrato solo per `tenant_id`, senza filtro su `date` o `booking_service_kind`, paginando 1000 righe alla volta; chiamata da `app/api/shuttle-schedules/route.ts:71` (GET) e indirettamente da ogni POST (riga 120: `return GET(request)`) e dopo ogni salvataggio in UI (`page.tsx`, `fetchSchedules`).
Doppio impatto:
1. Performance: costo crescente con l'accumulo di dati stagionali, nessun indice sfruttato (l'unico indice pertinente, `idx_services_booking_kind_date`, richiede un filtro su `booking_service_kind` che la query non applica).
2. Correttezza: se esiste una vecchia navetta (stagione precedente) con la stessa chiave di una attuale, `valid_from` mostrato in UI può risalire a un anno prima, fuorviando l'operatore sul badge di stagionalità.
Soluzione minima sicura: filtrare la query con `.in("booking_service_kind", ["navetta","shuttle_hotel"])` (con fallback compatibile per righe pre-migrazione 0163 identificate solo da `vessel`) e/o `.gte("date", oggi - N giorni)`, sfruttando l'indice esistente.
Soluzione strutturale: tabella dedicata (F-01) o vista materializzata con `GROUP BY`.

---

**F-07 — Nessun test di tenant isolation dedicato per le route shuttle-schedules**
Stato: TEST MANCANTE.
Evidenza: i 31 test esistenti (`tests/unit/shuttle-schedules-patch-*.test.ts`) usano tutti un solo tenant fisso e verificano solo la validazione delle date, mai l'isolamento multi-tenant. Il commit `df0cc44` ("fix: enforce tenant isolation in ops routes", verificato con `git show --stat`) ha toccato solo `app/api/ops/escursioni/route.ts` e `app/api/ops/pickup-runs/route.ts` — **non** `app/api/shuttle-schedules/**`.
Verifica di sicurezza effettuata: il codice attuale è comunque tenant-safe per costruzione (il `tenant_id` usato in ogni query proviene sempre da `auth.membership.tenant_id`, mai dall'`id` decodificato o dal body) — nessun IDOR sfruttabile trovato. Il problema è l'assenza di un test di regressione che lo garantisca nel tempo: un futuro refactor potrebbe rimuovere il filtro `.eq("tenant_id", ...)` senza che nessun test se ne accorga.
Soluzione: aggiungere `tests/unit/shuttle-schedules-tenant-isolation.test.ts` che verifichi, tramite spy sulle chiamate al client Supabase mockato, che ogni query di delete/insert/select applichi sempre il filtro `tenant_id` della sessione autenticata, indipendentemente dal contenuto dell'`id` decodificato.

---

**F-08 — Nessuna idempotenza sulla POST: rischio duplicati da doppio click o retry**
Stato: RISCHIO CONCRETO.
Evidenza: `app/api/shuttle-schedules/route.ts:80-121` inserisce sempre nuove righe senza verificare l'esistenza di uno schedule identico per le stesse date; nessun `UNIQUE` constraint su `services` copre questa combinazione di colonne.
Scenario: doppio click su "Crea navetta" o retry automatico del browser dopo timeout di rete → righe duplicate nel piano, possibili doppi invii successivi.
Soluzione minima sicura: query di esistenza prima dell'insert (stessi filtri di `deleteMatchingFutureServices`), rifiuto con messaggio esplicito se trovata corrispondenza.
Soluzione strutturale: indice `UNIQUE` parziale + gestione conflitto lato DB.

---

**F-09 — Race condition tra due operatori che modificano la stessa navetta**
Stato: RISCHIO CONCRETO (BASSA probabilità, ma nessuna mitigazione presente).
Evidenza: nessun lock, versioning (`updated_at`/ETag) o `SELECT … FOR UPDATE`; l'`id` è calcolato lato client al caricamento pagina.
Scenario: due operatori aprono la stessa navetta, la modificano in parallelo con campi diversi → possibile creazione di due schede duplicate invece di un "ultimo vince" pulito.
Soluzione minima sicura: nessuna migrazione; avviso "ricarica prima di modificare" in UI, o timestamp di controllo lato server.
Soluzione strutturale: lock ottimistico via RPC.

---

### MEDIA

**F-10 — `hotel_id` non verificato per appartenenza al tenant corrente**
Stato: BUG CONFERMATO (isolamento dati incompleto).
Evidenza: sia POST (`route.ts:10`) sia PATCH (`[id]/route.ts:10`) validano `hotel_id` solo come UUID, senza verificare che l'hotel appartenga a `auth.membership.tenant_id`. `hotels.tenant_id` esiste ma non viene incrociato.
Soluzione minima sicura: query di verifica `hotels.id = hotel_id AND tenant_id = auth.membership.tenant_id` prima dell'insert/update, 400 se non trovato.

**F-11 — Messaggi di errore Postgres esposti al client**
Stato: BUG CONFERMATO (information disclosure verso utenti già autenticati).
Evidenza: `app/api/shuttle-schedules/route.ts:73,114-117`; `app/api/shuttle-schedules/[id]/route.ts:139-142,163-166` — `error.message` propagato direttamente nella risposta JSON.
Soluzione minima sicura: log interno (`auditLog`) + messaggio generico al client.

**F-12 — `decodeShuttleScheduleId` fuori dal blocco try/catch nel PATCH**
Stato: BUG CONFERMATO (incoerenza, non sicurezza).
Evidenza: `app/api/shuttle-schedules/[id]/route.ts:106` è fuori dal `try` che inizia a riga 132; nel DELETE la stessa decodifica è invece protetta (righe 160-167). Un id malformato causa un'eccezione non gestita invece di un 400 controllato.
Soluzione minima sicura: spostare la decodifica dentro un try/catch dedicato con risposta 400 esplicita.

**F-13 — Fallback di classificazione "navetta" basato sul testo libero `vessel`**
Stato: RISCHIO CONCRETO.
Evidenza: `lib/shuttle-schedules.ts:43-52` — se `booking_service_kind` non è valorizzato, un servizio con `vessel` uguale (case-insensitive) a `"navetta"` viene comunque incluso nella gestione navette, esponendolo a DELETE/PATCH massivi.
Soluzione minima sicura: verifica di sola lettura di quanti servizi rientrano in questo fallback prima della stagione; nessuna modifica di codice a rischio zero disponibile ora.
Soluzione strutturale: rendere `booking_service_kind` obbligatorio in scrittura ed eliminare il fallback.

**F-14 — Duplicazione di `buildRows`/`buildServiceRows` e logica di chunking insert**
Stato: DEBITO TECNICO.
Evidenza: `app/api/shuttle-schedules/route.ts:30-48` e `app/api/shuttle-schedules/[id]/route.ts:31-49` sono identiche riga per riga; stesso per la logica di chunking a 500.
Soluzione strutturale: estrarre in `lib/shuttle-schedules.ts`.

**F-15 — Aggregazione pesante in memoria JS invece di GROUP BY SQL**
Stato: PERFORMANCE.
Evidenza: `deriveShuttleSchedules` (`lib/shuttle-schedules.ts:74-128`) esegue raggruppamento e calcolo min/max su tutto il dataset scaricato, in JS.
Soluzione minima: risolta in gran parte applicando il filtro di F-06.
Soluzione strutturale: vista/funzione SQL con `GROUP BY`.

**F-16 — Indice mancante per la query di `deleteMatchingFutureServices`**
Stato: PERFORMANCE/DEBITO TECNICO.
Evidenza: nessun indice copre `(tenant_id, direction, time, customer_name, vessel, date)`, la combinazione realmente usata nel filtro DELETE/PATCH.
Soluzione minima: nessuna migrazione ora; monitorare con `EXPLAIN ANALYZE` se si osservano lentezze.
Soluzione strutturale: indice dedicato post-stagione.

**F-17 — Errori di scrittura non loggati (assenza di osservabilità)**
Stato: DEBITO TECNICO.
Evidenza: i blocchi `catch` di PATCH/POST/DELETE non chiamano `auditLog`, a differenza di `authorizeServiceRoleRequest` che lo fa per errori di autenticazione.
Soluzione minima sicura: aggiungere `auditLog` nei blocchi catch (modifica additiva, basso rischio).

**F-18 — Campi obbligatori del form senza validazione client né indicazione visiva**
Stato: UX.
Evidenza: `app/(app)/settings/shuttles/page.tsx:186-219,392-539` — nessun asterisco, nessun `required`, nessun controllo prima della fetch; l'unico feedback di obbligatorietà arriva dal server dopo il roundtrip.
Soluzione minima sicura: asterischi sui campi obbligatori + controllo client minimo che blocchi il submit con messaggio chiaro, solo testo/logica, zero rischio grafico.

**F-19 — Terminologia "Direzione" (Hotel→esterno / Esterno→hotel) disallineata da "Andata/Ritorno" già usato in tabella**
Stato: UX (rischio di scelta errata della direzione).
Evidenza: `page.tsx:435-436` (form) vs `page.tsx:339` (tabella).
Soluzione minima sicura: allineare le etichette del select alla terminologia della tabella.

**F-20 — Default `days_of_week` esclude la Domenica senza segnalazione**
Stato: UX (rischio operativo reale).
Evidenza: `page.tsx:53` (`emptyForm.days_of_week: [1,2,3,4,5,6]`), ordine label `DAYS_LABEL` che parte da Domenica (`page.tsx:9`), non standard per l'utente italiano.
Scenario: operatore crea una navetta senza toccare i giorni, pensando siano "tutti", e la Domenica resta silenziosamente esclusa.
Soluzione minima sicura: nota testuale esplicita sotto il selettore giorni; verificare che la Domenica sia visivamente selezionabile e chiara.

**F-21 — Cancellazione ottimistica in UI senza refetch**
Stato: UX (possibile disallineamento stato UI/DB).
Evidenza: `page.tsx:238` — dopo DELETE, la riga viene rimossa localmente con `filter()` invece di rifare `fetchSchedules` come avviene dopo il salvataggio (riga 221); se il DELETE fallisce silenziosamente lato server con status 200, la UI mostrerebbe la navetta come cancellata mentre nel DB esiste ancora.
Soluzione minima sicura: sostituire il filtro locale con un refetch, coerente col pattern già usato per il save.

**F-22 — Nessun disabled state sul bottone "Elimina" durante la richiesta**
Stato: UX (rischio doppio submit).
Evidenza: `page.tsx:549` ha `disabled={saving}` sul bottone Salva, ma il bottone Elimina (righe 360-366) non ha alcuno stato di caricamento per riga.
Soluzione minima sicura: stato `deletingId` per disabilitare il bottone della riga specifica durante la richiesta.

**F-23 — Messaggi di errore fallback generici**
Stato: UX.
Evidenza: `page.tsx:122,125,216,235` — fallback generici ("Errore nel caricamento navette.", ecc.) se l'API non restituisce un campo `error`.
Soluzione minima sicura: testo più actionable nei 3 fallback.

**F-24 — Errore su DELETE sostituisce l'intera pagina invece di un errore locale**
Stato: UX.
Evidenza: `page.tsx:242` — in caso di errore di cancellazione, lo stato globale `error` sostituisce l'intera lista navette con un messaggio a piena pagina, nascondendo anche le navette funzionanti.
Soluzione minima sicura: mostrare l'errore in un banner/toast locale invece di sostituire tutta la vista.

**F-25 — `docs/shuttle-module.md` vuoto**
Stato: DEBITO TECNICO.
Evidenza: file presente ma 0 byte; nessuna architettura dichiarata da verificare.
Soluzione: documentare almeno il punto architetturale chiave (assenza di tabella dedicata, F-01/F-02) post-stagione.

### BASSA / MIGLIORAMENTO

**F-26** — Codice morto: `isShuttleLikeService` e `resolveShuttleHotelName` (`lib/shuttle-schedules.ts:70-72,148-150`) mai importati altrove (verificato con grep incrociato). Nessuna azione urgente.

**F-27** — Voce di menu "Navette" collocata in Impostazioni → Operativo (`lib/app-shell-nav.tsx:367`) invece che nell'area operativa quotidiana; possibile difficoltà di scoperta per un operatore junior. Nessuna azione urgente.

**F-28** — Nessuna funzione "duplica navetta" dedicata: feature assente, non bug. La sua eventuale introduzione dovrebbe tenere conto del rischio F-02 (collisione di identità).

**F-29** — `lib/piano-shuttle-pair.ts` non ha alcuna dipendenza tecnica diretta da `lib/shuttle-schedules.ts` (verificato via grep): l'affinità è solo semantica sul nome "navetta". Nessuna azione richiesta, solo nota per chi pianifica refactoring futuri per non assumere un accoppiamento inesistente.

## Task completati (non reintrodurre)

- **Tenant isolation nelle route operative** — commit `df0cc44`. Copre `app/api/ops/escursioni/route.ts` e `app/api/ops/pickup-runs/route.ts`. Non copre `app/api/shuttle-schedules/**`, ma quest'ultimo risulta comunque tenant-safe per costruzione indipendente (F-07 documenta solo la mancanza del test di regressione, non un bug).
- **`valid_to` obbligatorio nel PATCH shuttle schedules** — commit `175a5a8`, verificato in `app/api/shuttle-schedules/[id]/route.ts:18`.
- **`valid_from` obbligatorio nel PATCH shuttle schedules** — commit `9a37134`, verificato in `app/api/shuttle-schedules/[id]/route.ts:17`.
- **Regressione `valid_to >= valid_from`** — commit `db71eaf`, verificato in `app/api/shuttle-schedules/[id]/route.ts:109-114` e `app/api/shuttle-schedules/route.ts:21-24` (zod `.refine`), coperto da test.

## Rischi per l'alta stagione (sintesi)

1. F-01 (CRITICA) — perdita di assegnazioni/pax/telefono ad ogni modifica navetta con corse già gestite.
2. F-02 (ALTA) — fusione silenziosa di periodi distinti, edit che sovrascrive periodi non voluti.
3. F-03 (ALTA) — finestra di "navetta scomparsa" per fallimento parziale non transazionale.
4. F-05 (ALTA) — bug di fuso orario nella finestra notturna, aumenta probabilità di F-01/F-03.
5. F-06 (ALTA) — degrado prestazionale crescente con l'accumulo dati stagionali.

## Debito tecnico rimandabile a post-stagione

F-14, F-15, F-16, F-25, F-26, F-27, F-29, e la parte strutturale di F-01/F-02/F-08/F-09/F-13 (introduzione di una vera tabella `shuttle_schedules`, RPC transazionale, indici dedicati, unificazione codice).

## Test mancanti (riepilogo)

- Tenant isolation dedicata su `shuttle-schedules` (F-07).
- GET/POST: raggruppamento `deriveShuttleSchedules`, chunk insert >500 righe, validazione range date su POST.
- DELETE: verifica singola chiamata, propagazione errore, nessun impatto su `insert`.
- Ruoli/autorizzazione: branch 401/403 mai testato nei mock esistenti.
- Sovrapposizione intervalli tra schedule diverse (test di caratterizzazione del comportamento attuale, F-02).
- E2E Playwright per il flusso completo crea/modifica/elimina navetta.

## Conclusioni del reviewer

**Esito: APPROVATO CON RISERVA.**

Verifica di conformità alle regole assolute: nessun file applicativo è stato modificato durante l'audit; nessun test esistente è stato alterato; nessuna migrazione è stata creata o eseguita; nessun commit o push è stato effettuato; il modulo WhatsApp non è stato toccato né analizzato. Tutti i file:riga citati nei finding sopra sono stati riletti direttamente dal reviewer al termine della raccolta e risultano corretti al momento dell'audit (HEAD `db71eaf`).

La riserva riguarda F-01: è il finding più grave individuato, confermato da tre agenti indipendenti con evidenza concreta (catena di `ON DELETE CASCADE` verificata nello schema SQL), ma la sua **soluzione strutturale** comporta una riscrittura della logica di scrittura che non è compatibile con il divieto di refactoring in alta stagione. La soluzione minima proposta (avviso bloccante in UI) riduce il rischio di errore umano ma non elimina il difetto architetturale sottostante — è un palliativo, non una correzione, e va comunicato esplicitamente a chi userà questo audit per decidere le priorità.

Limiti dell'audit: nessun accesso al database Supabase reale (solo file locali/migrazioni); l'impatto quantitativo di F-06/F-16 (performance) non è stato misurato con `EXPLAIN ANALYZE` su dati di produzione; l'occorrenza reale di F-02 (schede fuse) non è stata verificata su dati live, resta un rischio dimostrato solo a livello di codice.
