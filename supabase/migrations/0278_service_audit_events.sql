-- Timeline/Audit per servizio — tabella per i SOLI gap reali identificati
-- nell'audit precedente (non duplica eventi già coperti in modo affidabile
-- da service_change_logs, bus_assignment_feedback, driver_assignment_history,
-- service_deletion_log, status_events, whatsapp_events). Copre: restore
-- servizio, rimozione autista/veicolo fuori Piano Giorno, import con source
-- strutturato, approvazione/rifiuto agenzia, creazione servizio da booking
-- group.
--
-- service_id NOT NULL ma SENZA foreign key verso public.services e SENZA
-- ON DELETE CASCADE (deliberato): questa tabella deve sopravvivere a un
-- hard-delete del servizio, esattamente come service_deletion_log
-- (0174_service_deletion_log.sql) già fa con original_service_id — a
-- differenza di service_change_logs/bus_assignment_feedback/status_events,
-- che invece HANNO una FK "on delete cascade" su services e vengono quindi
-- spazzate via insieme al servizio. Stessa scelta conservativa per
-- tenant_id: nessuna FK verso public.tenants, append-only reale.
create table if not exists public.service_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  booking_id uuid null,
  event_type text not null,
  source text not null,
  actor_user_id uuid null references auth.users (id) on delete set null,
  actor_name text null,
  actor_email text null,
  reason text null,
  old_data jsonb null,
  new_data jsonb null,
  metadata jsonb null,
  created_at timestamptz not null default now()
);

-- Indice primario per la query della timeline (Fase 6: tenant_id +
-- service_id + created_at desc, con id come tie-break per la keyset
-- pagination quando più eventi condividono lo stesso created_at).
create index if not exists idx_service_audit_events_tenant_service_created
  on public.service_audit_events (tenant_id, service_id, created_at desc, id desc);

create index if not exists idx_service_audit_events_tenant_created
  on public.service_audit_events (tenant_id, created_at desc);

alter table public.service_audit_events enable row level security;

-- Hardening esplicito a livello di GRANT (difesa in profondità, non solo
-- RLS): di default Supabase concede GRANT ampi su anon/authenticated a
-- livello di schema. Qui li revochiamo esplicitamente e concediamo SOLO
-- SELECT ad authenticated — anche se un domani una policy INSERT/UPDATE/
-- DELETE venisse aggiunta per errore, senza il GRANT corrispondente
-- l'operazione resterebbe comunque negata (due livelli di difesa
-- indipendenti, non uno solo). anon non ha alcun privilegio: zero SELECT,
-- zero scrittura.
revoke all on public.service_audit_events from anon;
revoke all on public.service_audit_events from authenticated;
grant select on public.service_audit_events to authenticated;

-- Difensivo/idempotente: rimuove eventuali policy INSERT/UPDATE/DELETE da
-- una bozza precedente di questa migration. Nessun effetto se non
-- esistevano già.
drop policy if exists service_audit_events_insert on public.service_audit_events;
drop policy if exists service_audit_events_update on public.service_audit_events;
drop policy if exists service_audit_events_delete on public.service_audit_events;

-- SELECT: stesso pattern di service_change_logs (0232) — solo il tenant
-- corrente, ruoli operativi, ristretto esplicitamente al ruolo
-- "authenticated" (anon non ha comunque alcun GRANT, vedi sopra — la
-- doppia restrizione è intenzionale).
drop policy if exists service_audit_events_select on public.service_audit_events;
create policy service_audit_events_select on public.service_audit_events
for select to authenticated using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- INSERT: DELIBERATAMENTE nessuna policy e nessun GRANT per
-- authenticated/anon. Le scritture avvengono SOLO via service role
-- (auth.admin, che bypassa RLS e i GRANT per definizione — vedi
-- lib/server/pricing-auth.ts) dai route/RPC server-side elencati in
-- lib/server/service-audit-events.ts. A differenza di status_events
-- (scrivibile oggi direttamente dal browser da più pagine),
-- service_audit_events non deve MAI accettare un insert client-side,
-- nemmeno da un utente autenticato con ruolo admin/operator: senza GRANT
-- INSERT (e senza policy INSERT), sia il privilegio SQL sia RLS negano
-- ogni tentativo del genere.
--
-- Nessuna policy né GRANT UPDATE/DELETE: append-only reale, nessuna
-- modifica o cancellazione possibile né da UI né da alcun ruolo
-- applicativo.
