-- FIX MIRATO ML STEP 1 — raccolta strutturata delle azioni di assegnazione
-- bus (prima assegnazione, spostamento, spostamento cross-linea, cambio
-- fermata, cancellazione, conferma/correzione di una proposta automatica).
--
-- Scelta: nuova tabella dedicata `bus_assignment_feedback`, non estensione
-- di `tenant_bus_allocation_moves` (0036/0037/0063). Quella tabella modella
-- SOLO lo spostamento bus-a-bus di un'allocazione già esistente (FK non
-- nullable su from/to_bus_unit_id, nessun concetto di "prima assegnazione",
-- "cancellazione" o "conferma automatica" — estenderla per questi casi
-- avrebbe richiesto rendere nullable colonne già in uso da RPC esistenti
-- (move_bus_allocation) e da query/report che già la leggono, con rischio
-- di regressione su codice funzionante. Una tabella nuova, additiva,
-- lascia `tenant_bus_allocation_moves` invariata (nessun rischio sulle RPC
-- esistenti) e può ospitare da subito tutti gli 8 tipi di azione richiesti
-- senza vincoli di schema ereditati.
--
-- Nessun dato live modificato da questa migration: solo DDL (tabella nuova,
-- indici, RLS). Nessuna riga viene scritta finché il codice applicativo non
-- la usa (vedi lib/server/bus-assignment-feedback.ts).

create table if not exists public.bus_assignment_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  action_type text not null check (action_type in (
    'initial_allocation',
    'move',
    'cross_line_move',
    'stop_change',
    'delete_allocation',
    'auto_confirmed',
    'auto_corrected'
  )),
  source text not null check (source in ('manual', 'mario', 'auto_assignment', 'ml_suggestion')),
  old_bus_unit_id uuid null references public.tenant_bus_units (id) on delete set null,
  new_bus_unit_id uuid null references public.tenant_bus_units (id) on delete set null,
  old_bus_line_id uuid null references public.tenant_bus_lines (id) on delete set null,
  new_bus_line_id uuid null references public.tenant_bus_lines (id) on delete set null,
  old_stop_id uuid null references public.tenant_bus_line_stops (id) on delete set null,
  new_stop_id uuid null references public.tenant_bus_line_stops (id) on delete set null,
  old_direction text null,
  new_direction text null,
  old_date date null,
  new_date date null,
  pax integer null check (pax is null or (pax > 0 and pax <= 120)),
  customer_name text null,
  hotel_name text null,
  derived_family_code text null,
  final_family_code text null,
  reason text null,
  metadata jsonb null,
  created_by_user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bus_assignment_feedback_tenant_created
  on public.bus_assignment_feedback (tenant_id, created_at desc);
create index if not exists idx_bus_assignment_feedback_tenant_service
  on public.bus_assignment_feedback (tenant_id, service_id);
create index if not exists idx_bus_assignment_feedback_tenant_action
  on public.bus_assignment_feedback (tenant_id, action_type);
create index if not exists idx_bus_assignment_feedback_tenant_source
  on public.bus_assignment_feedback (tenant_id, source);
create index if not exists idx_bus_assignment_feedback_tenant_old_line
  on public.bus_assignment_feedback (tenant_id, old_bus_line_id);
create index if not exists idx_bus_assignment_feedback_tenant_new_line
  on public.bus_assignment_feedback (tenant_id, new_bus_line_id);
create index if not exists idx_bus_assignment_feedback_tenant_old_unit
  on public.bus_assignment_feedback (tenant_id, old_bus_unit_id);
create index if not exists idx_bus_assignment_feedback_tenant_new_unit
  on public.bus_assignment_feedback (tenant_id, new_bus_unit_id);

alter table public.bus_assignment_feedback enable row level security;

-- Stesso pattern RLS di tenant_bus_allocation_moves (0036): tenant isolation
-- via current_tenant_id(), scritture riservate ad admin/operator. Le
-- scritture applicative avvengono sempre via auth.admin (service role, che
-- bypassa RLS) — questa policy è il backstop per eventuali accessi diretti
-- con la chiave anon/authenticated.
drop policy if exists bus_assignment_feedback_tenant_all on public.bus_assignment_feedback;
create policy bus_assignment_feedback_tenant_all on public.bus_assignment_feedback
for all
using (tenant_id = public.current_tenant_id())
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
