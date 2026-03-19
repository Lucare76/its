# Ischia Transfer Beta

Beta vendibile per agenzie transfer.

## Stack ufficiale
- Stack ufficiale: **Next.js + Supabase** (cartelle root `app/`, `components/`, `lib/`, `supabase/`).
- Legacy congelato read-only: `server/` e `client/` (non usare per nuove feature).
- Nota tecnica: [docs/official-stack.md](./docs/official-stack.md)

## Stack
- Next.js App Router + TypeScript strict + Tailwind + pnpm
- Supabase Free (Auth + Postgres + RLS)
- Leaflet + OpenStreetMap
- Deploy target: Vercel Free

## Beta gratuita
- La vetrina pubblica e deployabile su Vercel Hobby senza cron e senza backend obbligatorio.
- Il form preventivo della beta funziona anche solo con `WhatsApp` e `mailto`, direttamente lato client.
- Configurazione minima: `NEXT_PUBLIC_APP_URL` e `NEXT_PUBLIC_DISABLE_SUPABASE=true`
- Nota completa: [docs/free-beta-deploy.md](./docs/free-beta-deploy.md)

## Setup locale
0. Apri **questa** cartella (`ischia-transfer-beta`) come workspace root nel terminale/IDE.
1. Copia `.env.example` in `.env.local`
2. Configura variabili Supabase e token webhook
3. `pnpm install`
4. `pnpm dev`

## Lavorare da Casa
Checklist rapida su un nuovo PC:
1. `git clone https://github.com/Lucare76/its.git`
2. `cd its`
3. `git checkout main && git pull`
4. Crea `.env.local` (non committare) con almeno:
   - `NEXT_PUBLIC_APP_URL`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `EMAIL_INBOUND_TOKEN`
5. `pnpm install`
6. `pnpm dev --port 3010`
7. Apri `http://localhost:3010`

Note importanti per farlo funzionare anche fuori ufficio o da un altro dispositivo:
- `NEXT_PUBLIC_APP_URL` deve essere l'URL reale da cui apri l'app, non `localhost`, quando usi un deploy o un tunnel pubblico.
- In Supabase `Authentication -> URL Configuration`, aggiungi lo stesso dominio in `Site URL` o `Additional Redirect URLs`.
- Per accesso da altri dispositivi sulla stessa rete locale, il dev server ora espone `0.0.0.0`; apri l'IP del PC ospite, ad esempio `http://192.168.x.x:3010`.
- Per accesso da reti esterne diverse, non basta Supabase: serve un deploy pubblico (Vercel) oppure un tunnel/reverse proxy verso il PC locale.

Smoke test inbound automatico (senza problemi di escaping `curl`):
1. In `cmd`: `set EMAIL_INBOUND_TOKEN=<token_reale>`
2. Opzionale: `set INBOUND_URL=https://ischia-transfer.vercel.app/api/inbound/email`
3. Esegui: `pnpm inbound:test`
4. Se `ok: true`, verifica su `/inbox` il `draft_service_id`.

## Variabili ambiente
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EMAIL_INBOUND_TOKEN`
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_TEMPLATE_NAME` (default: `transfer_reminder`)
- `WHATSAPP_TEMPLATE_LANGUAGE` (default: `it`)
- `WHATSAPP_ALLOW_TEXT_FALLBACK` (`true|false`, default: `false`)
- `WHATSAPP_CRON_SECRET`
- `WHATSAPP_REMINDER_WINDOW_MINUTES` (default: `15`)
- `WHATSAPP_REMINDER_2H_ENABLED` (`true|false`, default: `false`)
- `NEXT_PUBLIC_REMINDER_ALERT_MINUTES` (default: `30`)

## Verifica produzione (Vercel)
1. Apri `Vercel Dashboard -> Project -> Settings -> Environment Variables`.
2. Verifica che siano presenti, per ogni ambiente richiesto (`Production` almeno):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EMAIL_INBOUND_TOKEN`
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_TEMPLATE_LANGUAGE`
- `WHATSAPP_ALLOW_TEXT_FALLBACK`
3. Se aggiorni una variabile, fai `Redeploy` del progetto.
4. Apri `/health` sull'app deployata e controlla:
- `Server Check: OK`
- `Client Check: OK`
- env Supabase/Email/WhatsApp tutti `present`

## Supabase
### File SQL
- Bootstrap schema: `supabase/bootstrap.sql`
- Seed demo: `supabase/seed_demo.sql`
- Migration service type v2: `supabase/migrations/0002_service_type_bus_tour.sql`

### Script helper locali
- `pnpm db:bootstrap` -> mostra percorso file + istruzioni SQL Editor
- `pnpm db:seed` -> mostra percorso file + istruzioni SQL Editor

Nota: i comandi `db:*` non eseguono SQL automaticamente. L'esecuzione va fatta nel SQL Editor Supabase.

### Procedura click-by-click (SQL Editor)
1. Vai su Supabase Dashboard del tuo progetto.
2. Menu sinistro -> `SQL Editor`.
3. Clicca `New query`.
4. Esegui `pnpm db:bootstrap`.
5. Copia tutto il contenuto di `supabase/bootstrap.sql`.
6. Incolla nella query e clicca `Run`.
7. Clicca di nuovo `New query`.
8. Esegui `pnpm db:seed`.
9. Copia tutto il contenuto di `supabase/seed_demo.sql`.
10. Incolla nella query e clicca `Run`.

### Deploy note: Service Type v2 (transfer + bus_tour) 
Se il database esiste gia:
1. Apri `SQL Editor` e esegui `supabase/migrations/0002_service_type_bus_tour.sql`.
2. Questo script:
- aggiunge `bus_tour` al tipo `service_type`
- aggiunge colonne `tour_name`, `capacity`, `meeting_point`, `stops`, `bus_plate`
- converte i legacy type (`excursion`, `shuttle`, `custom`) in `transfer`
3. Facoltativo: riesegui `supabase/seed_demo.sql` per dati demo aggiornati.

## Demo users
### Creazione utenti demo in Supabase Auth
1. Menu sinistro -> `Authentication` -> `Users`.
2. Clicca `Add user`.
3. Crea questi utenti con password `demo123`:
- `admin@demo.com`
- `operator@demo.com`
- `driver@demo.com`
- `agency@demo.com`
4. Se richiesto, conferma l'email per ogni utente.

### Collega utenti al tenant demo (memberships)
1. Torna in `SQL Editor` -> `New query`.
2. Copia/incolla il contenuto di `supabase/attach_demo_users.sql`.
3. Clicca `Run`.
4. Esegui questo passaggio solo dopo aver creato i 4 utenti in `Authentication -> Users`.

### Configura `.env.local`
1. In root progetto crea `.env.local` partendo da `.env.example`.
2. Inserisci:
- `NEXT_PUBLIC_APP_URL` con il dominio reale dell'app (`http://IP-LOCALE:3010` in LAN, dominio Vercel in deploy)
- `NEXT_PUBLIC_SUPABASE_URL` dal progetto Supabase
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` da Project Settings -> API
- `SUPABASE_SERVICE_ROLE_KEY` da Project Settings -> API
- `EMAIL_INBOUND_TOKEN` a tua scelta
3. Non committare `.env.local`.

### Supabase Auth URL Configuration
Se login o magic link funzionano solo su un PC e non altrove, controlla anche Supabase:
1. Apri `Authentication -> URL Configuration`.
2. Imposta `Site URL` con il dominio principale reale dell'app.
3. Aggiungi in `Additional Redirect URLs` tutti gli URL usati davvero:
- `http://localhost:3010`
- `http://127.0.0.1:3010`
- eventuale `http://192.168.x.x:3010`
- dominio Vercel o dominio custom
4. Salva e riprova il login.

## Scope coperto
- Landing pubblica con CTA, features, come funziona
- Auth + RBAC ruoli admin/operator/driver/agency
- Dashboard KPI + filtri + drawer + timeline
- Nuova prenotazione + area agency + mie prenotazioni
- Dispatch assegnazione driver/mezzo
- Driver mobile-first con stati PARTITO/ARRIVATO/COMPLETATO
- Mappa OSM con hotel + layer servizi + sidebar
- Email ingestion endpoint + inbox UI + conversione servizio
- WhatsApp Cloud API: invio reminder, webhook status, cron T-24h, alert mancata consegna
- Configurazione tenant WhatsApp (template/lingua/2h/fallback testo) via UI admin

## WhatsApp Cloud API (MVP)
Guida rapida completa: `docs/whatsapp-setup.md`

### Endpoint
- `POST /api/whatsapp/send`
  - body: `{ "service_id": "<uuid>" }`
  - auth: `Authorization: Bearer <Supabase access token>`
  - RBAC: solo `admin`/`operator`
  - aggiorna su `services`: `phone_e164`, `reminder_status`, `message_id`, `sent_at`
  - registra eventi in `whatsapp_events`
- `GET /api/whatsapp/webhook`
  - verifica webhook Meta (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /api/whatsapp/webhook`
  - riceve stati messaggio (`sent`, `delivered`, `read`, `failed`)
  - aggiorna `services.reminder_status`
  - registra eventi in `whatsapp_events`
- `GET/POST /api/cron/whatsapp-reminders`
  - job schedulato (Vercel cron) ogni 15 minuti
  - invia reminder per servizi in finestra `24h` e opzionale `2h`
  - evita doppio invio per fase usando `whatsapp_events.payload_json.phase`
  - auth: `Authorization: Bearer <WHATSAPP_CRON_SECRET>`
- `GET/POST /api/whatsapp/settings` (solo `admin`)
  - salva configurazione tenant su `tenant_whatsapp_settings`

### UI Admin
- pagina `/settings/whatsapp`
  - template default
  - lingua template
  - abilita/disabilita reminder 2h
  - abilita/disabilita fallback messaggio testo

### Configurazione webhook e cron
1. In Meta Developer Dashboard configura il webhook a:
   - `https://<tuo-dominio>/api/whatsapp/webhook`
2. Inserisci in app env:
   - `WHATSAPP_VERIFY_TOKEN` uguale al token usato in Meta
3. Crea `vercel.json` con cron su:
   - `/api/cron/whatsapp-reminders` ogni 15 minuti
4. Imposta in Vercel lo stesso segreto usato per cron:
   - `WHATSAPP_CRON_SECRET`
5. Env scheduler opzionali:
   - `WHATSAPP_REMINDER_WINDOW_MINUTES` (tolleranza finestra)
   - `WHATSAPP_REMINDER_2H_ENABLED=true` per secondo promemoria a 2h

### Stima costi (400 messaggi/settimana)
- WhatsApp Cloud API usa pricing a conversazione/template (varia per paese e categoria).
- Per 400 reminder/settimana, il costo settimanale tipico e nell'ordine di pochi euro fino a poche decine, a seconda di:
  - categoria template
  - paese dei destinatari
  - eventuali free tier/conversazioni gratuite
- Formula pratica:
  - `costo_settimana = conversazioni_billed * prezzo_unitario`
  - con 400 reminder: `400 * prezzo_unitario`
- Verifica finale su pricing ufficiale Meta prima del go-live:
  - https://business.whatsapp.com/products/platform-pricing

## Qualita
- Zod validation su form e webhook
- Loading/empty/error states principali
- Nessun segreto nel repository

## Check
- `pnpm lint`
- `pnpm build`

## Smoke E2E (Playwright)
Suite coperta:
- login
- create service
- assign driver
- driver cambia stato
- export excel (smoke in demo mode: verifica messaggio fallback senza Supabase)

### Run locale
1. Installa dipendenze:
   - `pnpm install`
2. Installa browser Playwright:
   - `pnpm exec playwright install chromium`
3. Esegui test:
   - `pnpm e2e`

Comandi utili:
- UI mode: `pnpm e2e:ui`
- headed: `pnpm e2e:headed`
- ops reali: `E2E_BASE_URL=http://127.0.0.1:3010 pnpm e2e:ops`

Note:
- la config e2e avvia `pnpm dev` su porta `3123`;
- per stabilita CI locale, le variabili Supabase sono forzate vuote nel webServer Playwright (modalita demo).
- per i test operativi reali PDF/dispatch usa un'app gia avviata con Supabase reale (`E2E_BASE_URL`) e credenziali demo valide in `.env.local`.

### CI
Workflow presente:
- `.github/workflows/e2e-smoke.yml`

Il job:
1. installa dipendenze
2. installa browser Chromium Playwright
3. esegue `pnpm e2e`
4. pubblica `playwright-report` come artifact

## Test manuale export Excel
### Caso 1: admin (deve funzionare)
1. Login come `admin@demo.com`.
2. Vai in Dashboard o Services list e clicca `Export`.
3. Imposta filtri (date, stato, nave/zona) e scarica.
4. Verifica nel file:
- fogli separati per tipo servizio (`transfer`, `escursione_bus`, ecc.)
- foglio `status_events` con `service_id, timestamp, old_status, new_status, actor`

### Caso 2: agency (solo servizi associati)
1. Login come `agency@demo.com`.
2. Ripeti export con lo stesso range date.
3. Verifica che nel file compaiano solo servizi associati all'utente agency (beta: servizi con eventi stato effettuati da quell'utente).

### Caso 3: driver (deve essere bloccato)
1. Login come `driver@demo.com`.
2. Clicca `Export` e avvia download.
3. Verifica messaggio errore user-friendly: ruolo non autorizzato all'export.
