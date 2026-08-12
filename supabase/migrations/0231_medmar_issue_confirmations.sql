-- Gate di conferma server-side per l'emissione Medmar One Click (Fase 2B.3).
--
-- Un window.confirm() lato browser non e' una protezione reale: qualunque
-- operatore autenticato potrebbe chiamare direttamente POST
-- /api/services/medmar-issue e avviare l'intera catena lock->booking->
-- payment. Questo token, single-use, breve scadenza, generato
-- esclusivamente server-side, dimostra che l'operatore ha visto ed
-- approvato la quota preflight PRIMA che qualunque mutazione Medmar possa
-- partire. Non contiene mai segreti/credenziali Medmar; service_ids ed
-- expected_total_cents sono solo lo scope del gate, non source of truth
-- per il payload mutativo (che resta sempre ricostruito fresco
-- server-side dall'orchestratore).
--
-- FASE 2B.3 — SOLO FILE LOCALE. NON applicare a nessun ambiente in questa
-- fase (nessuna chiamata apply_migration/execute_sql, locale o remota).

create table if not exists public.medmar_issue_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  service_ids uuid[] not null,
  expected_total_cents integer not null,
  route_snapshot jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (timezone('utc'::text, now()) + interval '5 minutes'),
  used_at timestamptz null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_medmar_issue_confirmations_token
  on public.medmar_issue_confirmations(token);

create index if not exists idx_medmar_issue_confirmations_tenant_created
  on public.medmar_issue_confirmations(tenant_id, created_at desc);

alter table public.medmar_issue_confirmations enable row level security;

drop policy if exists medmar_issue_confirmations_select_ops on public.medmar_issue_confirmations;
create policy medmar_issue_confirmations_select_ops on public.medmar_issue_confirmations
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_issue_confirmations_insert_ops on public.medmar_issue_confirmations;
create policy medmar_issue_confirmations_insert_ops on public.medmar_issue_confirmations
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

drop policy if exists medmar_issue_confirmations_update_ops on public.medmar_issue_confirmations;
create policy medmar_issue_confirmations_update_ops on public.medmar_issue_confirmations
for update using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
) with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);
