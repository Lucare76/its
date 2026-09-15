-- Migration 0281: system_job_runs — colonna run_id dedicata + unique index
-- per idempotenza REALE sotto concorrenza (Fix P1-3, audit pre-go-live).
--
-- ROOT CAUSE: startJobRun inseriva sempre una nuova riga; il fix
-- applicativo precedente (SELECT su metadata->>'run_id' poi INSERT) mitiga
-- i retry sequenziali ma NON due richieste realmente concorrenti —
-- dimostrato da un test dedicato (tests/unit/job-health.test.ts): due
-- startJobRun in Promise.all con lo stesso run_id, senza questo indice,
-- producevano 2 righe.
--
-- tenant_id e' nullable (job system-wide: backup, poll-emails,
-- whatsapp-reminders, postgres-backup, storage-backup possono girare senza
-- un tenant applicativo). Un semplice UNIQUE INDEX su
-- (tenant_id, job_key, run_id) NON garantirebbe l'unicita' per le righe con
-- tenant_id NULL, perche' Postgres tratta ogni NULL come distinto ai fini
-- di un vincolo UNIQUE ordinario — due run system-wide con lo stesso
-- job_key/run_id potrebbero comunque duplicarsi.
--
-- SCELTA: unique index PARZIALE su un'espressione che normalizza
-- tenant_id NULL a un sentinel UUID fisso (coalesce), cosi' due righe
-- system-wide con lo stesso job_key/run_id collidono correttamente.
-- Preferita a NULLS NOT DISTINCT (disponibile solo da PostgreSQL 15+):
-- non c'e' una conferma live della versione del cluster di produzione in
-- questa sessione (nessun accesso diretto al DB) — evito una sintassi
-- version-dipendente non verificata. La documentazione DR interna
-- (docs/disaster-recovery.md) riporta un manifest reale con
-- postgres_server_version "15.8", ma nota esplicitamente che la produzione
-- "puo' essere stata aggiornata a 15/16/17": non e' una conferma
-- sufficiente per assumere la sintassi PG15+.

-- 1) Colonna dedicata (nullable: i chiamanti senza un run_id esterno
-- stabile — backup, poll-emails, whatsapp-reminders, postgres-backup-
-- report — continuano a non passarla, comportamento invariato).
alter table public.system_job_runs
  add column if not exists run_id text null;

-- 2) Backfill dai soli run che oggi hanno gia' un run_id dentro metadata
-- (storage-backup, unico chiamante che lo passa finora). Idempotente:
-- tocca solo le righe con run_id ancora NULL, non sovrascrive nulla.
update public.system_job_runs
  set run_id = metadata->>'run_id'
  where run_id is null
    and metadata->>'run_id' is not null;

-- 3) Unique index parziale, sentinel per tenant_id NULL.
--
-- LOCK: senza CONCURRENTLY, CREATE UNIQUE INDEX prende uno SHARE lock che
-- blocca le SCRITTURE (non le letture) su system_job_runs per la durata
-- della build dell'indice. Su questa tabella (audit/health, poche righe al
-- giorno da cron/report) l'impatto atteso e' minimo. Se si preferisce
-- evitare del tutto il blocco scritture, usare CONCURRENTLY — ma va
-- eseguito come istruzione SEPARATA (non incollata insieme al resto in
-- un unico batch nel SQL Editor): CREATE INDEX CONCURRENTLY non puo'
-- girare dentro un blocco di transazione, e molti runner di script SQL
-- avvolgono un file incollato in una transazione implicita.
--
-- SE ESISTONO DUPLICATI STORICI: questo CREATE UNIQUE INDEX fallisce con
-- un errore che elenca la prima chiave duplicata (tenant_id/job_key/run_id)
-- trovata, e si interrompe QUI — i passi 1-2 sopra restano comunque
-- applicati (colonna aggiunta e backfillata), ma l'indice non viene
-- creato. Nessuna riga viene cancellata automaticamente da questa
-- migration: un eventuale duplicato storico va risolto manualmente
-- (deduplicare le righe o annullare il run_id in conflitto su quelle da
-- non considerare più "la stessa esecuzione") prima di poter rieseguire
-- questo CREATE INDEX.
create unique index if not exists idx_system_job_runs_tenant_job_run_unique
  on public.system_job_runs (
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    job_key,
    run_id
  )
  where run_id is not null;

-- ROLLBACK logico (non eseguito qui, solo documentato):
--   drop index if exists public.idx_system_job_runs_tenant_job_run_unique;
--   alter table public.system_job_runs drop column if exists run_id;
-- Sicuro: run_id è additivo (nullable, mai referenziato da FK), l'indice
-- copre solo le righe con run_id non nullo — nessuna perdita di dati
-- preesistenti in caso di rollback.
