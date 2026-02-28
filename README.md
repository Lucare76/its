# ITS - Ischia Transfer Service

Scaffold iniziale per il CMS gestionale richiesto. Questo repository contiene due cartelle principali:

- `server` — backend Node.js + Express + Prisma (SQLite)
- `client` — frontend Vite + React (demo UI per invio prenotazioni)

Funzionalità incluse nel template:
- Auth JWT con ruoli `AGENCY` e `OPERATOR`
- Endpoint API `/api/auth` (register/login)
- Endpoint API `/api/bookings` (crea/prendi/approva prenotazioni)
- Endpoint API `/api/dispatch` (pianificazione mezzi su prenotazioni confermate)
- Endpoint API `/api/hotels` (anagrafica hotel con coordinate geografiche)
- Endpoint API `/api/vehicles` (flotta mezzi noleggio)
- Endpoint API `/api/accounting` (estratti conto settimanali agenzie)
- Export prenotazioni CSV (compatibile Excel) via `/api/bookings/export.csv`
- Filtri + ordinamento + paginazione su prenotazioni (`status`, `service`, `dateFrom`, `dateTo`, `sortBy`, `sortDir`, `page`, `pageSize`)
- KPI prenotazioni via `/api/bookings/kpi`
- Import prenotazioni da file `/api/bookings/import` (`.csv`/`.pdf`, ruolo operatore)
- Dashboard operatore con sezione `Dispatch e pianificazione mezzi`
- Ordinamento fermate bus via geolocalizzazione hotel (`/api/dispatch/bus/ordered-stops`)
- Raggruppamento automatico arrivi nave/treno con suggerimento mezzo (`/api/dispatch/grouped-arrivals`)
- Database SQLite con Prisma

Come avviare (Windows):

Metodo veloce (consigliato):

```bash
cd c:\Users\user\Downloads\its
npm install
npm run dev
```

Se trovi porte occupate (`EADDRINUSE`), usa:

```bash
npm run dev:reset
```

Per avviare tutto e aprire automaticamente il browser:

```bash
npm run demo
```

Apri poi `http://localhost:5173` nel browser.

1. Apri due terminali separati.

2. Installare le dipendenze e avviare il server:

```bash
cd c:\Users\user\Downloads\its\server
npm install
npm run prisma:generate
npm run prisma:push
npm run seed
npm run dev
```

3. Installare dipendenze e avviare il client:

```bash
cd c:\Users\user\Downloads\its\client
npm install
npm run dev
```

Note:
- Credenziali operatore demo: `lucarenna76@gmail.com` / `operator123`
- Recupero password:
	- `POST /api/auth/forgot-password` con `email`
	- `POST /api/auth/reset-password` con `token` e `newPassword`
	- invio email reale via SMTP se configurato, altrimenti URL di reset nei log backend
	- dopo reset riuscito, viene inviata email di conferma cambio password
	- il sistema salva data e IP dell'ultimo cambio password (`/api/auth/me`)
	- il link email usa `?resetToken=...` e il frontend precompila automaticamente il campo token
	- nell'area prenotazioni c'è il bottone `Esporta CSV`
	- nell'area prenotazioni sono disponibili filtri, ordinamento e paginazione
	- operatore: bottone `Da validare` + upload file CSV/PDF per import massivo
	- operatore: pianificazione dispatch con endpoint:
		- `GET /api/dispatch` lista piani mezzi
		- `GET /api/dispatch/unplanned` prenotazioni confermate non pianificate
		- `POST /api/dispatch` crea piano mezzo
		- `PUT /api/dispatch/:id` aggiorna piano mezzo
		- `GET /api/dispatch/bus/ordered-stops?date=YYYY-MM-DD&vehicle=...` ordine fermate bus per distanza
		- `GET /api/dispatch/port-shuttle?date=YYYY-MM-DD&port=ISCHIA_PORTO&service=transfer|bus|all` navetta porto-hotel da arrivi nave
		  - porti disponibili: ISCHIA_PORTO, CASAMICCIOLA, FORIO, LACCO_AMENO, SANT_ANGELO
		- `GET /api/dispatch/grouped-arrivals?date=YYYY-MM-DD&mode=SHIP|TRAIN&windowMinutes=30` gruppi arrivi e mezzo suggerito
		- `POST /api/dispatch/grouped-arrivals/create-dispatch` crea piani dispatch in batch da un gruppo
		- `GET /api/dispatch/vehicle-availability?vehicle=...&scheduledAt=...` verifica preventiva disponibilità mezzo
		- `DELETE /api/dispatch/:id` elimina piano dispatch (operatore)
	- contabilità / estratti conto:
		- `GET /api/accounting/statements` lista estratti conto
		- `POST /api/accounting/statements/generate-weekly` genera/aggiorna estratti della settimana precedente
		- `GET /api/accounting/statements/:id/export.csv` export CSV estratto conto
		- `GET /api/accounting/statements/:id/export.pdf` export PDF estratto conto
		- `POST /api/accounting/statements/:id/send-email` invia estratto PDF via email (SMTP richiesto)
	- anagrafica hotel/geolocalizzazione:
		- `GET /api/hotels` lista hotel
		- `POST /api/hotels` crea hotel (operatore)
		- `POST /api/hotels/import-osm` importa strutture ricettive da OSM/Overpass (body opzionale: `{ "limit": 200 }`)
		- `PUT /api/hotels/:id` aggiorna hotel (operatore)
		- `PUT /api/bookings/:id/hotel` assegna hotel a prenotazione (operatore)
		- `DELETE /api/bookings/:id` elimina prenotazione (operatore, solo senza dispatch)
	- anagrafica flotta mezzi:
		- `GET /api/vehicles` lista mezzi disponibili
		- `POST /api/vehicles` crea mezzo (operatore)
		- `PUT /api/vehicles/:id` aggiorna mezzo (operatore)
		- `GET /api/vehicles/unavailability` lista indisponibilità mezzi
		- `POST /api/vehicles/:id/unavailability` crea indisponibilità oraria mezzo
		- `DELETE /api/vehicles/unavailability/:entryId` rimuove indisponibilità
- Configurazione SMTP (file `server/.env`):
	- `SMTP_HOST` (es. `smtp.gmail.com`)
	- `SMTP_PORT` (`587` con TLS STARTTLS)
	- `SMTP_SECURE` (`false` per 587)
	- `SMTP_USER` (email SMTP)
	- `SMTP_PASS` (App Password Gmail)
	- `MAIL_FROM` mittente visibile
	- `MAIL_LOGO_URL` logo opzionale mostrato nell'email
	- backup giornaliero database SQLite:
		- `DAILY_BACKUP_ENABLED` (`true`/`false`, default `true`)
		- `DAILY_BACKUP_TIME` (formato `HH:mm`, default `02:30`)
		- `BACKUP_DIR` (cartella backup relativa a `server`, default `backups`)
		- `BACKUP_RETENTION_COUNT` (numero backup da mantenere, default `7`)
		- backup manuale: `cd server && npm run backup:run`
		- ingest email IMAP verso `Da validare`:
			- endpoint manuale operatore: `POST /api/bookings/inbox/sync` (body opzionale: `{ "limit": 20 }`)
			- scheduler automatico backend (polling):
				- `IMAP_INGEST_ENABLED` (`true`/`false`, default `false`)
				- `IMAP_HOST` (es. `imap.gmail.com`)
				- `IMAP_PORT` (default `993`)
				- `IMAP_SECURE` (`true` per SSL/TLS)
				- `IMAP_USER` (utenza mailbox)
				- `IMAP_PASS` (password/App Password)
				- `IMAP_MAILBOX` (default `INBOX`)
				- `IMAP_POLL_MINUTES` (default `5`)
				- `IMAP_MAX_MESSAGES` (default `25`)
				- `IMAP_MARK_SEEN` (`true`/`false`, default `true`)
				- `IMAP_TLS_REJECT_UNAUTHORIZED` (`true`/`false`, default `true`; usa `false` solo se il provider usa certificati non trusted)
				- `IMAP_DEFAULT_SERVICE` (`transfer`/`bus`, default `transfer`)
			- campi email estratti automaticamente (best effort): servizio, pax, hotel, modalità viaggio (SHIP/TRAIN), riferimento viaggio, arrivo, prezzo
			- deduplica su `Message-ID` email (`sourceMessageId`)
	- nel form reset è disponibile il pulsante mostra/nascondi password
	- template email responsive con supporto dark mode e footer legale automatico
	- nel footer email il contatto supporto è cliccabile (`mailto`)
- Per parsing automatico email/PDF avanzato e contabilità automatica saranno moduli separati da implementare.
- Il dispatch ora impedisce assegnazioni su mezzi marcati indisponibili nel relativo intervallo orario.
- Il dispatch applica un tempo cuscinetto tra servizi sullo stesso mezzo (`DISPATCH_BUFFER_MINUTES`, default `30`).
- I dispatch con lo stesso identico orario restano consentiti per supportare i gruppi collettivi.
- Se `prisma db push` non è eseguibile (binari bloccati), refresh token e audit log funzionano in fallback non persistente.

Flotta iniziale pre-caricata (seed):
- Kassbohrer Setra 315 HDH (55)
- Mercedes O404 (55)
- Mercedes 350 SHD (53)
- Kassbohrer Setra 210 HD (39)
- Mercedes 413 (17)
- Mercedes 312 (12)
- Mercedes E270 (4)
- Mercedes Vito (8)
- Mercedes V220 (7)
- Mercedes E 270 (5)

Formato import consigliato (`CSV` o testo tabellare in `PDF`):
- `agencyEmail,service,passengers,hotelName,hotelId,travelMode,travelRef,arrivalAt,priceTotal`
- `hotelName` o `hotelId` sono opzionali ma utili per i servizi bus/transfer
- `travelMode` accetta `SHIP` o `TRAIN`; `arrivalAt` va in formato ISO (`2026-02-22T08:20:00Z`)
- esempio: `agenzia@example.com,bus,3,Hotel Ischia Porto,,SHIP,SNAV 08:20,2026-02-22T08:20:00Z,95.50`

Prossimi passi raccomandati (posso farli io):
- Aggiungere DB e migrazioni (Postgres + Prisma o Sequelize)
- Sistema utenti/ruoli (JWT + bcrypt)
- Parser email/PDF (worker + queue)
- Pagine per area agenzie e pannello operatore

Smoke test automatico (PowerShell):
- `./smoke-test.ps1 -Mode quick` test rapido (health, auth, flotta, indisponibilità, availability, grouped endpoint)
- `./smoke-test.ps1 -Mode full` test completo end-to-end (include batch dispatch con cleanup automatico)
- `./smoke-test.ps1 -Mode full -ReportFormat json -ReportDir .\reports` esporta report JSON
- `./smoke-test.ps1 -Mode full -ReportFormat both -ReportDir .\reports` esporta report JSON + CSV
- `./smoke-test.ps1 -Mode full -MaxStepDurationMs 2000 -PerfMode warn` segnala step lenti senza fallire il test
- `./smoke-test.ps1 -Mode full -MaxStepDurationMs 2000 -PerfMode fail` fallisce il test se uno step supera la soglia
- esecuzione con credenziali sicure (`PSCredential`):
	- `$op = Get-Credential`
	- `$ag = Get-Credential`
	- `./smoke-test.ps1 -Mode full -OperatorCredential $op -AgencyCredential $ag`
- alternativa con variabili ambiente (senza argomenti password in chiaro):
	- `$env:SMOKE_OPERATOR_PASSWORD="..."`
	- `$env:SMOKE_AGENCY_PASSWORD="..."`
	- `./smoke-test.ps1 -Mode full`
	- nota: i fallback password in chiaro sono disattivati; senza credenziali sicure lo script termina con errore
- KPI inclusi nel report: `durationSeconds`, `successRate`, `slowestSteps` e `DurationMs` per ogni step
