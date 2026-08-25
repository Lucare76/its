-- Costo AI per ogni importazione prenotazioni (IMAP + PDF manuale).
--
-- import_id referenzia inbound_emails: unico "unità di importazione" tracciata
-- oggi nello schema. È nullable perché:
--  - la chiamata Claude avviene PRIMA che la riga inbound_emails esista (va
--    quindi loggata subito con import_id null e poi collegata via UPDATE);
--  - l'estrazione manuale da /api/pdf/claude-extract (upload interattivo, mai
--    persistita in inbound_emails) non ha mai un import_id.
-- source distingue le due origini per il filtro in dashboard.

create table if not exists public.ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  import_id uuid null references public.inbound_emails (id) on delete set null,
  source text not null check (source in ('imap', 'manual')),
  provider text not null default 'anthropic',
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10,6) not null default 0,
  failed boolean not null default false,
  error_message text null
);

create index if not exists ai_usage_log_tenant_created_idx
  on public.ai_usage_log (tenant_id, created_at desc);

create index if not exists ai_usage_log_import_idx
  on public.ai_usage_log (import_id);

alter table public.ai_usage_log enable row level security;

drop policy if exists "ai_usage_log_service_role_all" on public.ai_usage_log;
create policy "ai_usage_log_service_role_all"
  on public.ai_usage_log
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "ai_usage_log_tenant_rw" on public.ai_usage_log;
create policy "ai_usage_log_tenant_rw"
  on public.ai_usage_log
  for all
  to authenticated
  using (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = ai_usage_log.tenant_id
      and role in ('admin','operator','supervisor')
  ))
  with check (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = ai_usage_log.tenant_id
      and role in ('admin','operator','supervisor')
  ));
