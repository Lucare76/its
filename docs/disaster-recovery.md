# ITS Disaster Recovery — Runbook V1 + V2 (off-provider)

## Obiettivo

Ridurre il rischio operativo in caso di perdita dati, errore umano, deploy difettoso o indisponibilita' del database.

Questo runbook NON esegue restore automatici in produzione. Il ripristino resta un'operazione esplicita e controllata.

## Stato attuale

ITS dispone di un backup applicativo notturno via `app/api/cron/backup/route.ts`, con due copie indipendenti generate dallo stesso JSON:

- **Backup primario — Supabase Storage** (bucket privato `backups`, nessun accesso pubblico): esportazione JSON delle 24 tabelle configurate, retention applicativa 15 giorni.
- **Copia off-provider — Cloudflare R2** (V2, bucket privato `its-backups-offsite`, nessun accesso pubblico): stesso JSON caricato su un provider diverso da Supabase, retention applicativa 90 giorni. Vedi `lib/server/r2-backup.ts`.
- Health monitoring: esecuzione cron (Job Health) e validita' strutturale dell'ultimo file Supabase (Operational Health) — vedi sezione dedicata sotto.

Il backup primario e la copia offsite hanno **stati indipendenti** nel risultato del job (`primary` vs `offsite_backup`): un fallimento della copia offsite non tocca mai il backup primario gia' salvato su Supabase (nessun rollback, nessuna cancellazione, nessun restore automatico).

Limiti attuali rilevanti per Disaster Recovery:

1. il backup applicativo copre un insieme limitato di tabelle (24, non l'intero schema);
2. non esiste ancora un restore drill automatizzato su ambiente isolato;
3. non esiste ancora una prova periodica documentata di RPO/RTO.

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

## Regola 3-2-1

Per un Disaster Recovery completo ITS deve arrivare gradualmente a:

- almeno 3 copie dei dati;
- su almeno 2 supporti/sistemi differenti;
- almeno 1 copia fuori dal provider primario.

Con la V2, la copia Cloudflare R2 soddisfa il requisito di copia off-provider (provider diverso da Supabase). Restano da consolidare: un vero restore drill ripetibile e una misura documentata di RPO/RTO reali.

## Restore automatico

Non previsto in V1.

Un restore automatico puo' trasformare un incidente recuperabile in perdita dati maggiore. La futura automazione dovra' limitarsi inizialmente a:

- scaricare il backup;
- validarlo;
- preparare un ambiente isolato;
- produrre un report PASS/FAIL;

senza toccare produzione.

## Frequenza drill consigliata

- controllo backup: giornaliero automatico;
- verifica snapshot: almeno settimanale;
- restore drill completo su ambiente isolato: mensile;
- revisione runbook: dopo ogni incidente SEV-1/SEV-2 o modifica strutturale importante al database.

## Criterio di completamento P0

Il P0 Disaster Recovery puo' considerarsi realmente chiuso solo quando ITS dispone di:

1. backup con copertura delle tabelle operative critiche — ✅ (24 tabelle, V1);
2. validazione automatica del file — ✅ (`scripts/verify-backup-snapshot.mjs`, V1);
3. copia off-provider — ✅ (Cloudflare R2, V2, questa PR);
4. restore drill ripetibile su ambiente isolato — ❌ ancora da fare;
5. report documentato con RPO/RTO misurati — ❌ ancora da fare.
