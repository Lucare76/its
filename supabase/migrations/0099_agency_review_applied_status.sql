-- Aggiunge lo status "applied" alla tabella agency_review_sessions
-- (dopo che l'operatore ha applicato le modifiche segnalate dall'agenzia)
alter table public.agency_review_sessions
  drop constraint if exists agency_review_sessions_status_check;

alter table public.agency_review_sessions
  add constraint agency_review_sessions_status_check
  check (status in ('pending','approved','modified','applied'));
