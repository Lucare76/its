-- Tabella per il flusso di approvazione modifiche profilo agenzia.
-- L'agenzia propone modifiche → l'operatore approva o rifiuta.
-- In caso di rifiuto l'agenzia deve fare "presa visione" prima di ripresentare.

create table if not exists public.agency_profile_changes (
  id                  uuid        default gen_random_uuid() primary key,
  tenant_id           uuid        not null,
  agency_id           uuid        not null,
  proposed_by_user_id uuid        not null,
  status              text        not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'superseded')),
  changes             jsonb       not null,
  rejection_note      text,
  acknowledged_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists agency_profile_changes_tenant_status
  on public.agency_profile_changes (tenant_id, status);
create index if not exists agency_profile_changes_agency
  on public.agency_profile_changes (agency_id);
