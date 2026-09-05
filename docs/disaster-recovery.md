# ITS Disaster Recovery — Runbook V1

## Obiettivo

Ridurre il rischio operativo in caso di perdita dati, errore umano, deploy difettoso o indisponibilita' del database.

Questo runbook NON esegue restore automatici in produzione. Il ripristino resta un'operazione esplicita e controllata.

## Stato attuale

ITS dispone gia' di un backup applicativo notturno via `app/api/cron/backup/route.ts`:

- esportazione JSON delle tabelle configurate;
- salvataggio nel bucket Supabase Storage privato `backups`;
- retention applicativa di 15 giorni;
- health monitoring separato per esecuzione cron e validita' del file prodotto.

Limiti attuali rilevanti per Disaster Recovery:

1. il backup applicativo copre un insieme limitato di tabelle;
2. il file di backup vive nello stesso ecosistema Supabase del database primario;
3. non esiste ancora un restore drill automatizzato su ambiente isolato;
4. non esiste ancora una prova periodica documentata di RPO/RTO.

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

## Regola 3-2-1 — roadmap

Per un Disaster Recovery completo ITS deve arrivare gradualmente a:

- almeno 3 copie dei dati;
- su almeno 2 supporti/sistemi differenti;
- almeno 1 copia fuori dal provider primario.

Il bucket Supabase `backups` e' utile, ma NON soddisfa da solo il requisito di copia off-provider.

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

1. backup con copertura delle tabelle operative critiche;
2. validazione automatica del file;
3. copia off-provider;
4. restore drill ripetibile su ambiente isolato;
5. report documentato con RPO/RTO misurati.
