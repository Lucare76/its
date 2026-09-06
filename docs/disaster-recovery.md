# ITS Disaster Recovery — Runbook V1 + V2 + V3

## Obiettivo

Ridurre il rischio operativo in caso di perdita dati, errore umano, deploy difettoso o indisponibilita' del database.

Questo runbook NON esegue restore automatici in produzione. Il ripristino resta un'operazione esplicita e controllata.

## Regola di verifica (leggere prima di tutto)

> **Un backup NON e' Disaster Recovery verificato finche' non e' stato eseguito con successo almeno un restore drill su ambiente isolato, con RPO/RTO misurati e documentati.**

Avere piu' copie di piu' formati riduce la probabilita' di perdere i dati, ma non dimostra che si possa tornare operativi. Finche' il drill non e' stato fatto, lo stato reale del DR ITS e' "backup presenti, restore non provato".

## Modello a 5 layer

| Layer | Cosa | Dove | Copertura | Retention | Owner |
|---|---|---|---|---|---|
| **1** | Supabase managed backup (piattaforma) | Supabase (automatico sul progetto) | Intero database gestito da Supabase (dipende dal piano: daily su Free/Pro, PITR su Pro add-on) | Gestita da Supabase | Supabase |
| **2** | JSON operational snapshot | `app/api/cron/backup/route.ts` (Vercel Cron `0 2 * * *`) → Supabase Storage, bucket privato `backups` | **24 tabelle** applicative selezionate (NON l'intero schema, NO `auth`, NO funzioni/RLS) | 15 giorni applicativi | ITS |
| **3** | R2 JSON offsite | `lib/server/r2-backup.ts`, stesso JSON del Layer 2 → Cloudflare R2 `its-backups-offsite`, prefix `production/` | Come Layer 2 | 90 giorni applicativi | ITS |
| **4** | **PostgreSQL full logical backup** | `scripts/postgres-backup.mjs` via GitHub Actions (`.github/workflows/postgres-backup.yml`, `30 2 * * *` UTC) — `pg_dump -Fc` | Schema `public` completo (DDL + dati + sequence + indici + constraint + FK + funzioni/RPC + trigger + viste + policy RLS) **+** 4 tabelle `auth` selezionate `--data-only` (`auth.users`, `auth.identities`, `auth.mfa_factors`, `auth.mfa_amr_claims`), per il login su un progetto Supabase fresco | 30 giorni rolling su R2 (mai l'ultimo set) | ITS |
| **5** | R2 PostgreSQL offsite | Stesso job del Layer 4 → Cloudflare R2, prefix **`production/postgres/`** | Come Layer 4 (`.dump` + `.auth.dump` + `.manifest.json`) | 30 giorni rolling (mai l'ultimo set) | ITS |

I layer **coesistono e sono indipendenti**:

- il JSON (Layer 2/3) resta la via di **verifica veloce** e di **recupero mirato** di singole tabelle (leggibile, diffabile, `scripts/verify-backup-snapshot.mjs`);
- il dump PostgreSQL (Layer 4/5) e' la **base del vero Disaster Recovery**: e' l'unico artefatto da cui si puo' ricostruire il database (schema + funzioni + RLS + `auth`).
- La retention del Layer 4/5 (`production/postgres/`) **non tocca mai** gli oggetti JSON del Layer 3 (`production/backup_*.json`): prefissi e pattern di nome file distinti, con guardia esplicita nello script.

Il backup primario (Layer 2) e la copia offsite (Layer 3) hanno **stati indipendenti** nel risultato del job (`primary` vs `offsite_backup`): un fallimento della copia offsite non tocca mai il backup primario gia' salvato su Supabase (nessun rollback, nessuna cancellazione, nessun restore automatico). Lo stesso vale per il Layer 4 (dump) rispetto al Layer 5 (upload R2): se l'upload fallisce, il job e' `failed` e nessun file e' considerato un backup valido (fail-fast).

Limiti attuali rilevanti per Disaster Recovery:

1. il backup JSON (Layer 2/3) copre un insieme limitato di tabelle (24, non l'intero schema);
2. il dump PostgreSQL (Layer 4/5) e' implementato ma **non ancora eseguito** contro produzione (attende autorizzazione — vedi "Primo backup e drill");
3. non esiste ancora un restore drill eseguito su ambiente isolato;
4. non esiste ancora una prova documentata di RPO/RTO reali.

## Obiettivi operativi V1

### RPO

Target iniziale: massimo 24 ore di perdita dati per il backup applicativo giornaliero.

### RTO

Target iniziale: riportare ITS in stato operativo entro 4 ore da un incidente grave, usando una procedura manuale controllata.

Questi sono target operativi iniziali, non SLA contrattuali.

## Regola fondamentale

Mai eseguire un restore direttamente su produzione senza:

1. identificare l'incidente;
2. congelare le scritture operative quando necessario;
3. selezionare e validare il backup;
4. verificare il restore su ambiente isolato;
5. controllare conteggi e integrita' dei dati;
6. autorizzare esplicitamente il ripristino finale.

## Procedura incidente

### 1. Classificazione

- **SEV-1**: database non disponibile, perdita/corruzione dati estesa, tenant compromesso.
- **SEV-2**: errore circoscritto a una funzione o tabella operativa recuperabile senza restore completo.
- **SEV-3**: anomalia senza perdita dati.

Solo SEV-1 deve portare normalmente alla valutazione di restore completo.

### 2. Stop del danno

Prima di ripristinare:

- evitare nuovi import massivi;
- evitare job che continuano a modificare dati interessati;
- annotare ora UTC dell'incidente;
- annotare ultimo momento noto in cui il sistema era sano.

### 3. Selezione backup

Scegliere il file `backup_YYYY-MM-DD.json` piu' recente precedente all'incidente.

Validarlo con:

```bash
node scripts/verify-backup-snapshot.mjs path/al/backup_YYYY-MM-DD.json
```

Il verificatore deve terminare con `BACKUP SNAPSHOT: PASS` prima di usare il file per un restore drill.

### 4. Restore drill

Il restore deve essere provato prima su un progetto/database Supabase NON production.

Controlli minimi dopo il restore:

- login e tenant ITS disponibili;
- servizi della giornata presenti;
- assignments coerenti;
- bus e allocazioni bus coerenti;
- agenzie e hotel presenti;
- booking group/import critici presenti;
- nessuna evidente contaminazione cross-tenant;
- Centro Operativo caricabile;
- test smoke applicativi verdi.

### 5. Decisione produzione

Procedere sul database reale solo se:

- il backup e' valido;
- il restore isolato ha successo;
- i conteggi critici sono coerenti;
- e' chiaro quali dati successivi al backup andranno persi o ricostruiti.

### 6. Dopo il restore

- verificare servizi imminenti e senza autista;
- verificare arrivi/partenze della giornata;
- verificare allocazioni bus;
- verificare email/import pendenti;
- verificare invii WhatsApp critici;
- registrare incidente, causa, backup usato, RPO reale e RTO reale.

## Disaster Recovery V2 — copia off-provider Cloudflare R2

### Flusso

```
database → snapshot JSON → upload Supabase Storage (primario)
                          → upload Cloudflare R2 (offsite, solo se il primario e' riuscito)
                          → verifica R2 (HeadObject, non un download completo)
                          → risultato job con stati separati (primary implicito nel successo dell'upload Supabase, offsite_backup esplicito)
```

### Env richieste (server-only, mai `NEXT_PUBLIC_*`)

| Variabile | Uso |
|---|---|
| `R2_ACCOUNT_ID` | Account Cloudflare (validato per completezza operativa) |
| `R2_ACCESS_KEY_ID` | Credenziale S3-compatible R2 |
| `R2_SECRET_ACCESS_KEY` | Credenziale S3-compatible R2 |
| `R2_BUCKET_NAME` | Bucket privato di destinazione (`its-backups-offsite`) |
| `R2_ENDPOINT` | Endpoint S3-compatible del bucket R2 |

Nessun valore di queste variabili viene mai stampato in log o incluso nel risultato del job (vedi `summarizeR2Error` in `lib/server/r2-backup.ts`, che ridacta ogni occorrenza letterale delle credenziali).

### Comportamento in caso di errore R2

- **Env R2 mancanti** (una o piu'): il backup primario Supabase procede comunque; `offsite_backup.status = "skipped"`, con l'elenco delle variabili mancanti nel messaggio d'errore (mai un fallback insicuro).
- **PutObject fallito**: `offsite_backup.status = "failed"`. Il backup primario resta valido, nessun retry automatico, nessuna azione sul bucket Supabase.
- **HeadObject fallito o `ContentLength` incoerente dopo un PutObject apparentemente riuscito**: considerato comunque `failed` — un PutObject senza errore non basta per considerare la copia offsite riuscita.
- **Purge R2 fallita**: riportata in `offsite_purge_errors`, il backup offsite appena creato resta valido; nessuna cancellazione viene tentata su Supabase in conseguenza di un errore R2.
- In tutti i casi sopra il job **non fallisce** (`ok: true`), ma il suo stato esecutivo complessivo diventa `warning` (mai `success` pieno) cosi' che l'assenza/il fallimento della copia offsite resti visibile nel Centro Salute ITS.

### Naming e retention

- Chiave R2: `production/backup_YYYY-MM-DD.json` (stesso nome file del backup Supabase, con prefisso `production/` per tenere il bucket organizzato — vedi `R2_BACKUP_PREFIX` in `lib/server/r2-backup.ts`).
- Retention R2: 90 giorni, applicativa (elenco oggetti sotto il prefisso `production/`, cancellazione solo di quelli con data-nome-file precedente al cutoff). Nessun oggetto recente viene mai cancellato.
- In alternativa/complemento, una lifecycle rule R2 gestita lato bucket Cloudflare (es. expiration automatica a 90gg) puo' sostituire o affiancare la purge applicativa in futuro — **non configurata automaticamente da questa PR**, da valutare e attivare manualmente lato Cloudflare se desiderato.

### Procedura di verifica

1. Controllare `job_health` (jobKey `backup`) nel Centro Salute ITS (`/settings/system` o `/api/admin/system-status`): il campo `metadata.offsite_backup.status` distingue `success` / `failed` / `skipped`.
2. In caso di dubbio, verificare manualmente nel bucket R2 (console Cloudflare, sola lettura) la presenza dell'oggetto `production/backup_YYYY-MM-DD.json` atteso.
3. Non e' previsto (ne' in V1 ne' in V2) un download automatico del file R2 per la verifica quotidiana: solo HeadObject (esistenza + dimensione).

## Disaster Recovery V3 — backup PostgreSQL logico completo (Layer 4 + 5)

### Perche' NON su Vercel

`pg_dump` non e' disponibile nel runtime serverless di Vercel (nessun binario PostgreSQL, nessun modo di installarlo), la durata massima di una function e' limitata, il filesystem `/tmp` e' effimero e piccolo, e la connection string al database non deve vivere nell'ambiente dell'app. Percio' il Layer 4/5 gira su **GitHub Actions** — infrastruttura gia' usata dal repo (`supabase-migrations.yml`), fisicamente separata dalla produzione, con `pg_dump`/`pg_restore` installabili e secret isolati.

### Flusso

```
GitHub Actions (30 2 * * * UTC, o workflow_dispatch)
  → apt install postgresql-client-17   (>= qualsiasi server Supabase attuale: 15/16/17)
  → psql "SHOW server_version_num"  →  verifica OBBLIGATORIA  pg_dump_major >= server_major
        (se falsa: FAIL immediato, PRIMA del dump)
  → pg_dump -Fc --no-owner --no-privileges --schema=public                                → its_full_<ts>.dump
  → pg_dump -Fc --no-owner --no-privileges --data-only
            --table=auth.users --table=auth.identities
            --table=auth.mfa_factors --table=auth.mfa_amr_claims                           → its_full_<ts>.auth.dump
  → controllo: exit code, file esiste, size > 0
  → verifica strutturale DISTINTA:
        PUBLIC  (pg_restore --list its_full_<ts>.dump)       → failed se TOC vuoto / niente schema
                                                               public / tabelle di controllo assenti;
                                                               unverified se manca solo `CREATE EXTENSION
                                                               unaccent` dal TOC (backup comunque tenuto);
                                                               altrimenti passed
        AUTH    (pg_restore --list its_full_<ts>.auth.dump)  → auth.users E auth.identities presenti,
                                                               altrimenti BACKUP FAILED
        PUBLIC failed  o  AUTH failed   → BACKUP FAILED
        PUBLIC unverified (AUTH passed) → backup valido, job "warning"
  → SHA-256 di ogni artefatto
  → upload su Cloudflare R2 (production/postgres/) + verifica HeadObject (dimensione)
  → manifest JSON (its_full_<ts>.manifest.json) → upload + verifica
  → retention 30gg rolling SOLO sotto production/postgres/ (mai l'ultimo set, mai il JSON)
  → cancellazione file temporanei locali SOLO dopo upload+verifica
  → (opzionale) POST /api/cron/postgres-backup-report  → riga in system_job_runs (Centro Salute)
```

Fail-fast: se la verifica versione client/server non passa, se `pg_dump` fallisce, se la verifica strutturale **PUBLIC e' `failed`** (TOC vuoto / niente schema public / tabelle di controllo assenti) **o AUTH e' `failed`**, o se l'upload/HeadObject R2 fallisce, il job e' **FAILED** e **nessun file e' considerato un backup valido**. Caso a parte: se PUBLIC e' `unverified` (manca solo `CREATE EXTENSION unaccent` dal TOC) e AUTH e' `passed`, il dump viene **comunque caricato e conservato** e il job va in **`warning`** — vedi "Verifica strutturale — dettaglio".

### Compatibilita' versione client/server

`config.toml` (`major_version = 15`) e' solo il DB di sviluppo locale: la produzione puo' essere stata aggiornata a 15/16/17. Regola di `pg_dump`: il client deve essere **major >= server**. Il workflow installa `postgresql-client-17` (dumpa qualsiasi server attuale) e lo script, **prima** del dump, legge `SHOW server_version_num` via `psql` (sola lettura), calcola `server_major` e `pg_dump_major` e **fallisce immediatamente** se `pg_dump_major < server_major` (helper `isClientVersionSufficient` / `versionCompatMessage` in `lib/server/postgres-backup.ts`, unit-testati). `pg_dump_version`, `pg_dump_major`, `pg_restore_version`, `postgres_server_version` e `postgres_server_major` finiscono nel manifest.

### Formato, scope e naming

- `pg_dump -Fc` (custom format): abilita `pg_restore` selettivo, `pg_restore --list` per la verifica, compressione integrata.
- **PUBLIC dump** — `--schema=public --no-owner --no-privileges`: schema completo (DDL + dati + sequence + indici + constraint + FK + funzioni/RPC + trigger + viste + policy RLS).
- **AUTH dump** — `--data-only` con lista **esplicita e selettiva** di tabelle: `auth.users`, `auth.identities`, `auth.mfa_factors`, `auth.mfa_amr_claims`.
  - **NON** si usa piu' `--schema=auth --data-only` sull'intero schema: `auth.schema_migrations` e `auth.instances` darebbero PK conflict su un progetto nuovo; `auth.sessions` / `auth.refresh_tokens` / `auth.flow_state` / `auth.one_time_tokens` sono legate al vecchio JWT secret e inutili; `auth.audit_log_entries` e' solo peso. Elenco esclusioni: `PG_BACKUP_AUTH_EXCLUDED_TABLES` in `lib/server/postgres-backup.ts`.
  - `auth.users.encrypted_password` e' bcrypt self-contained: con `auth.users` + `auth.identities` ripristinate, gli utenti si autenticano con le password esistenti (il progetto nuovo mint-a nuovi token con il proprio JWT secret — vedi "Restore PostgreSQL").
  - **SSO/SAML:** ITS **non** usa oggi SSO/SAML. Se verranno introdotti, la lista `PG_BACKUP_AUTH_TABLES` andra' rivalutata (aggiungere `auth.sso_providers` / `auth.sso_domains` / `auth.saml_providers` / `auth.saml_relay_states`).
- Naming (UTC): `its_full_YYYY-MM-DD_HH-mm.dump`, `its_full_YYYY-MM-DD_HH-mm.auth.dump`, `its_full_YYYY-MM-DD_HH-mm.manifest.json`.
- Chiavi R2: `production/postgres/its_full_YYYY-MM-DD_HH-mm.<ext>`. **Nessun dump precedente viene mai sovrascritto** (il timestamp al minuto garantisce l'unicita').

### Manifest (nessun segreto / PII)

```json
{
  "schema_version": 2,
  "created_at": "2026-09-06T02:30:12.000Z",
  "base_name": "its_full_2026-09-06_02-30",
  "backup_date": "2026-09-06",
  "postgres_server_version": "15.8",
  "postgres_server_major": 15,
  "pg_dump_version": "pg_dump (PostgreSQL) 17.2 ...",
  "pg_dump_major": 17,
  "pg_restore_version": "pg_restore (PostgreSQL) 17.2",
  "format": "custom",
  "connection": "session-pooler",
  "dump_scope": {
    "full": "--schema=public",
    "auth": "--data-only --table=auth.users --table=auth.identities --table=auth.mfa_factors --table=auth.mfa_amr_claims",
    "auth_tables_included": ["auth.users", "auth.identities", "auth.mfa_factors", "auth.mfa_amr_claims"],
    "auth_tables_excluded": ["auth.schema_migrations", "auth.instances", "auth.sessions", "auth.refresh_tokens", "auth.audit_log_entries", "auth.flow_state", "auth.one_time_tokens"]
  },
  "artifacts": [
    { "filename": "...dump", "kind": "full", "size_bytes": 0, "sha256": "...", "r2_key": "production/postgres/...", "r2_verified": true },
    { "filename": "...auth.dump", "kind": "auth", "size_bytes": 0, "sha256": "...", "r2_key": "...", "r2_verified": true }
  ],
  "verification": {
    "status": "passed",
    "public": { "status": "passed", "pg_restore_list_entries": 0, "has_public_schema": true, "checked_tables_present": [], "checked_tables_missing": [], "unaccent_extension_present": true, "notes": [] },
    "auth": { "status": "passed", "pg_restore_list_entries": 0, "has_users": true, "has_identities": true, "tables_present": ["auth.users", "auth.identities"], "notes": [] }
  },
  "totals": { "artifact_count": 2, "total_size_bytes": 0 },
  "duration_ms": 0,
  "retention_days": 30,
  "runner": "github-actions"
}
```

`verification.status` (overall) puo' essere:

- `passed` — `verification.public.status` **e** `verification.auth.status` entrambi `passed`;
- `unverified` — nessuno dei due `failed` ma `verification.public.status` e' `unverified` (manca solo `unaccent` dal TOC): il dump e' comunque caricato/conservato, il job Centro Salute va in `warning`;
- `failed` — `public` **o** `auth` sono `failed`: nessun file e' un backup valido.

### Verifica strutturale — dettaglio

- **PUBLIC** (`verifyRestoreList`), tre esiti:
  - `failed` — TOC vuoto, oppure nessun riferimento allo schema `public`, oppure una o piu' tabelle di controllo assenti dal TOC (dump troncato/vuoto ⇒ inutilizzabile).
  - `unverified` — struttura ok ma **manca dal TOC** il `CREATE EXTENSION unaccent`. **Non e' un blocco provato:** `unaccent` e' creata come estensione in `public` nella migrazione `0189` e usata **una sola volta**, in un backfill dati una-tantum (`INSERT ... SELECT public.unaccent(...)` nella stessa `0189`). Nessun **indice**, **funzione**, **vista** o **colonna generata** di ITS dipende da `unaccent` (verificato: unica ricorrenza in tutto il repo). Un dump `--schema=public` normalmente porta comunque `CREATE EXTENSION unaccent` nel TOC; se per qualche motivo non c'e', il restore degli oggetti ITS **non** fallisce, e sul progetto fresco basta `CREATE EXTENSION unaccent;` a mano (contrib disponibile su Supabase). Percio' l'assenza declassa la verifica a `unverified` (backup tenuto, job `warning`), **non** a `failed`.
  - `passed` — struttura ok **e** `unaccent` presente nel TOC.
  - La detection di `unaccent` e' robusta rispetto alle varianti di formato di `pg_dump` (`EXTENSION - unaccent`, `EXTENSION unaccent`, `COMMENT ... EXTENSION unaccent`) e non produce falsi positivi su nomi di funzione che contengono la sottostringa `unaccent`.
- **AUTH** (`verifyAuthRestoreList`): `auth.users` **e** `auth.identities` devono comparire nel TOC del dump auth, altrimenti **BACKUP FAILED**. `auth.mfa_factors` / `auth.mfa_amr_claims` possono mancare (progetto senza MFA) senza far fallire la verifica.

### Retention

30 giorni rolling su R2, applicata **solo** al prefix `production/postgres/`. Un "set di backup" = i 3 file che condividono lo stesso `base_name`. Regole (vedi `selectExpiredBackupSets` in `lib/server/postgres-backup.ts`, unit-testate):

- si elimina un set solo se la sua data e' precedente al cutoff (oggi − 30gg);
- **il set piu' recente non viene MAI eliminato**, anche se piu' vecchio di 30gg;
- nessuna chiave fuori dal prefix, e nessuna chiave del set appena creato, puo' finire nella lista di cancellazione (guardia difensiva nello script);
- il sistema di retention JSON (Layer 3, `production/backup_*.json`) resta intatto.

### GitHub Secrets richiesti

Da configurare in **Settings → Secrets and variables → Actions** del repo (solo nomi, mai valori qui):

| Secret | Uso |
|---|---|
| `SUPABASE_DB_URL` | **Session Pooler URI** di produzione, porta **5432**: `postgresql://postgres.<project-ref>:<DB_PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres`. Dashboard Supabase → **Project Settings → Database → Connection string → Session pooler**. `<project-ref>`, `<region>` e `<DB_PASSWORD>` NON vanno hardcodati qui. **Server-only, mai `NEXT_PUBLIC_*`, mai committata, mai stampata** (redazione in `redactSecrets` / `maskConnectionString`). <br>• **Session Pooler (5432)** = consentito per `pg_dump`. <br>• **Transaction Pooler (6543)** = NON usare (non supporta `pg_dump`). <br>• **Direct** (`db.<ref>.supabase.co:5432`) = NON usare dai runner GitHub-hosted: e' IPv6-only e i runner non hanno IPv6 (servirebbe l'add-on IPv4 di Supabase o un self-hosted runner con IPv6). |
| `R2_ACCOUNT_ID` | Account Cloudflare |
| `R2_ACCESS_KEY_ID` | Credenziale S3-compatible R2 |
| `R2_SECRET_ACCESS_KEY` | Credenziale S3-compatible R2 |
| `R2_BUCKET_NAME` | Bucket privato di destinazione (lo stesso del JSON: `its-backups-offsite`) |
| `R2_ENDPOINT` | Endpoint S3-compatible del bucket R2 |
| `DR_HEALTH_REPORT_URL` *(opzionale)* | Es. `https://<app>/api/cron/postgres-backup-report` — se assente, il backup gira comunque, senza health ping |
| `DR_HEALTH_REPORT_SECRET` *(opzionale)* | Bearer per l'endpoint di report; anche env server-side dell'app |

Nessun valore di questi secret compare nel workflow, nei log del job o nel manifest.

### Osservabilita' (Layer 8) — job DISTINTO da "backup"

Il workflow, a fine esecuzione, chiama `POST /api/cron/postgres-backup-report` (auth `Bearer DR_HEALTH_REPORT_SECRET`), che registra una riga in `system_job_runs` con `job_key = "postgres-backup"` — **distinto** dal job `backup` (snapshot JSON).

Nel Centro Salute ITS (`/api/admin/system-status`, card "Stato sistema" di Controllo Giornata):

- `postgres-backup` e' `scheduled`, cadenza giornaliera, `staleAfterMinutes = 30h`, `criticalConsecutiveFailures = 2`, `staleSeverity = critical`;
- un `pg_dump`/R2 fallito → run `failed` → health `warning` al primo KO, `critical` da 2 KO consecutivi o se nessun run entro 30h;
- **un backup JSON verde (`backup` healthy) NON fa risultare verde il DR**: `computeOverallHealth` prende il peggiore tra i job abilitati, quindi `postgres-backup` critical ⇒ stato ITS complessivo `critical`.

### Restore PostgreSQL

**Non incluso in V3.** V3 si ferma alla **creazione e verifica** del backup. Il restore da `pg_restore` sara' progettato e implementato come **fase separata**, e non e' ancora considerato verificato.

Non e' un flusso "`supabase db push` completo → `pg_restore` full public": far girare le migrazioni e poi ripristinare il dump completo dello schema `public` produrrebbe conflitti `already exists` (tabelle, tipi, funzioni, policy create due volte). La fase di restore dovra' scegliere **una sola strategia**, testarla e documentarla (es. progetto vuoto senza migrazioni + `pg_restore` singolo; oppure `pg_restore --clean --if-exists` controllato; oppure restore selettivo via `--use-list`).

Requisiti gia' noti che la procedura di restore dovra' coprire:

1. **progetto Supabase isolato** e dedicato (mai la produzione);
2. **schema / system objects Supabase compatibili** con il dump (stessa major PostgreSQL, estensioni disponibili, ruoli `supabase_*` presenti);
3. **`auth.users` deve esistere prima** di caricare i dati `public` che lo referenziano via FK (`user_id`);
4. **evitare la doppia creazione dello schema `public`** (una sola fonte di verita' per il DDL: o le migrazioni o il dump, non entrambe);
5. **ricostruire** cio' che il dump `--schema=public` non contiene:
   - Storage buckets e relative policy (`storage.buckets` / `storage.objects` RLS);
   - publication Realtime (`supabase_realtime`);
   - migration ledger (`supabase_migrations.schema_migrations`) allineato;
6. **aggiornare le env Supabase dell'app** verso il nuovo progetto (`NEXT_PUBLIC_SUPABASE_URL`, anon key, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` del backup);
7. **riconfigurare nel nuovo progetto**: Site URL, Redirect URLs, SMTP, template email, eventuali provider OAuth;
8. **tutti gli utenti dovranno rifare login** (i token/sessioni del vecchio progetto sono legati al vecchio JWT secret — per questo `auth.sessions` / `auth.refresh_tokens` non sono nel backup);
9. **verificare i grant PostgREST** (`anon`, `authenticated`, `service_role`) sulle tabelle/funzioni ripristinate;
10. **verificare `unaccent`**: `CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;` se non gia' presente dopo il restore.

> La procedura esatta di restore verra' definita e validata durante il Restore Drill; non e' ancora considerata verificata.

Dettagli tecnici gia' identificati per lo script dedicato: ordine di `--use-list`, gestione del ciclo FK `tenant_bus_line_stops ↔ tenant_bus_allocations`, import dei dati `auth` prima dei dati `public`.

## Regola 3-2-1

Per un Disaster Recovery completo ITS deve arrivare gradualmente a:

- almeno 3 copie dei dati;
- su almeno 2 supporti/sistemi differenti;
- almeno 1 copia fuori dal provider primario.

Con la V2 la copia Cloudflare R2 (JSON) soddisfa il requisito di copia off-provider. Con la V3 si aggiunge un artefatto qualitativamente diverso — un dump PostgreSQL logico completo — anch'esso off-provider su R2. Restano da consolidare: un vero restore drill ripetibile e una misura documentata di RPO/RTO reali.

## Restore automatico

Non previsto in V1.

Un restore automatico puo' trasformare un incidente recuperabile in perdita dati maggiore. La futura automazione dovra' limitarsi inizialmente a:

- scaricare il backup;
- validarlo;
- preparare un ambiente isolato;
- produrre un report PASS/FAIL;

senza toccare produzione.

## Storage — gap noto (non coperto da V3)

V3 copre database (`public`) e dati `auth`. **Non** copre i file in Supabase Storage. Stato dei bucket:

| Bucket | Contenuto | Rigenerabile? | Priorita' DR |
|---|---|---|---|
| `vehicle-documents` | PDF di conformita' veicolo (revisioni, assicurazioni, bollo, …) caricati dagli operatori | **No** — originali forniti da terzi, non ricostruibili | **Alta** (non rigenerabile / importante) |
| `vehicle-damage-photos` | Foto danni veicolo | **No** — evento puntuale, non ripetibile | Media (non rigenerabile / priorita' inferiore) |
| `bus-qr-codes` | QR code prenotazioni bus | **Si'** — rigenerati dall'app dai dati del DB | Bassa (rigenerabile) |
| `backups` | Snapshot JSON applicativi (Layer 2) | — gia' un artefatto di backup, gia' copiato su R2 (Layer 3) | Nessuna (non ha senso duplicare un backup) |

Finche' non esiste una copia offsite di `vehicle-documents`, un incidente che colpisce anche lo Storage del progetto comporta la **perdita definitiva** di quei PDF. Il DB verrebbe ripristinato dal dump V3, ma i riferimenti ai file punterebbero a oggetti inesistenti.

## Roadmap DR

- **DR V4 candidate: offsite backup del bucket `vehicle-documents`.** (Sync periodico verso R2 o download/upload dal job GitHub Actions; da progettare — **non** implementato in V3.)
- Restore drill PostgreSQL ripetibile su progetto isolato + misura RPO/RTO reali (vedi "Regola di verifica").
- Definizione e validazione della procedura di restore PostgreSQL (vedi "Restore PostgreSQL").

## Frequenza drill consigliata

- controllo backup: giornaliero automatico;
- verifica snapshot: almeno settimanale;
- restore drill completo su ambiente isolato: mensile;
- revisione runbook: dopo ogni incidente SEV-1/SEV-2 o modifica strutturale importante al database.

## Primo backup e drill (V3)

Il codice della V3 e' pronto ma **non e' mai stato eseguito contro produzione**. Sequenza per attivarlo in sicurezza:

1. **Configurare i GitHub Secrets** elencati sopra (`SUPABASE_DB_URL` + i 5 `R2_*`; opzionali i 2 `DR_HEALTH_*`).
2. **Primo run manuale in dry-run**: Actions → *PostgreSQL Full Backup (DR V3)* → *Run workflow* → `dry_run = true`. Valida solo tool/env/connettivita' R2, non esegue `pg_dump` ne' upload.
3. **Primo backup reale**: stesso workflow con `dry_run = false`. Produce il primo set `its_full_<ts>.*` in `production/postgres/`.
4. **Verificare il primo dump**: scaricare `its_full_<ts>.dump` da R2 e controllare in locale:
   `pg_restore --list its_full_<ts>.dump | head` (TOC popolato, schema `public`, tabelle attese) e confrontare lo `sha256` con quello del manifest.
5. **Restore drill** (fase successiva, non V3): ripristinare in un progetto Supabase isolato, misurare RPO/RTO reali, documentarli qui.

## Criterio di completamento P0

Il P0 Disaster Recovery puo' considerarsi realmente chiuso solo quando ITS dispone di:

1. backup con copertura delle tabelle operative critiche — 🟡 parziale (JSON: 24 tabelle, V1; PostgreSQL: schema `public` completo + `auth` data-only, V3 — **da eseguire**);
2. validazione automatica del file — ✅ (`scripts/verify-backup-snapshot.mjs` per il JSON; `pg_restore --list` + SHA-256 + HeadObject per il dump, V3);
3. copia off-provider — ✅ (Cloudflare R2: JSON in V2, dump PostgreSQL in V3);
4. restore drill ripetibile su ambiente isolato — ❌ ancora da fare;
5. report documentato con RPO/RTO misurati — ❌ ancora da fare.

Finche' 4 e 5 non sono chiusi, vale la **Regola di verifica** in cima a questo documento: il DR ITS non e' verificato.
