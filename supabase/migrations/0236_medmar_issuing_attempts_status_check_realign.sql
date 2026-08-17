-- Migration: riallineamento del CHECK constraint su
-- medmar_issuing_attempts.status alla lista di 16 stati gia' prevista dal
-- codice (lib/server/medmar-booking/issue-types.ts: MedmarIssueStatus) e
-- dalla migrazione originale 0230_medmar_issuing_attempts.sql.
--
-- Root cause (Fase 2C recovery, 2026-08-17): un audit empirico (insert di
-- prova per ciascuno dei 16 valori, poi rollback) contro il database di
-- produzione ha confermato che il constraint reale accetta 15 dei 16
-- valori e rifiuta esclusivamente 'preflight_started'. La migrazione
-- 0230 non e' mai stata modificata dopo la creazione (confermato via
-- `git log --follow`): il constraint di produzione e' stato applicato in
-- una forma incompleta rispetto al file, e la guardia
-- `create table if not exists` in 0230 impedisce a qualunque riapplicazione
-- successiva di correggerlo, perche' la tabella esiste gia'.
--
-- Sintomo osservato: il primo test reale Medmar One Click su una pratica
-- reale (GERARDO D'ADDIO) e' fallito con Postgres 23514 al primo
-- `insert` di un attempt in stato 'preflight_started', DOPO che il
-- contesto sessione Medmar (openTurn) era gia' stato risolto — vedi anche
-- la Fase 3 dello stesso recovery in issue-orchestrator.ts, che sposta
-- l'acquisizione dell'attempt PRIMA di qualunque mutazione Medmar cosi'
-- che un fallimento locale come questo non lasci mai una mutazione remota
-- non tracciata.
--
-- Il nuovo constraint e' un SUPERSET del vecchio (aggiunge solo
-- 'preflight_started' alla lista consentita): nessuna riga esistente puo'
-- violarlo, zero rischio di perdita/alterazione dati. Nessuna altra
-- modifica a tabella/dati.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'medmar_issuing_attempts_status_check'
      and conrelid = 'public.medmar_issuing_attempts'::regclass
  ) then
    alter table public.medmar_issuing_attempts
      drop constraint medmar_issuing_attempts_status_check;
  end if;

  alter table public.medmar_issuing_attempts
    add constraint medmar_issuing_attempts_status_check
    check (status in (
      'preflight_started',
      'preflight_ok',
      'lock_started',
      'locked',
      'booking_started',
      'booked',
      'payment_started',
      'paid',
      'unlock_started',
      'completed',
      'preflight_failed',
      'lock_failed',
      'booking_failed_definitive',
      'payment_failed_definitive',
      'remote_state_unknown',
      'manual_review'
    ));
end $$;
