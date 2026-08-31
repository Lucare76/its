-- FASE A.2 — cost tracking delle chiamate LLM dell'Assistente Mario.
--
-- PERCHÉ UNA TABELLA DEDICATA (e non ai_usage_log):
--  ai_usage_log è legata all'importazione prenotazioni — FK a inbound_emails,
--  CHECK source in ('imap','manual'), cost_usd NOT NULL, nessun user_id /
--  latency_ms / action / esito router. Riadattarla significherebbe allentare
--  vincoli di un altro sottosistema. Qui una tabella minima e isolata.
--
-- UNA RIGA = UNA chiamata LLM reale (una invocazione di routeMarioWithLlm).
-- Il fast-path deterministico NON chiama Claude → NON scrive nulla qui
-- (costo 0, nessun incremento di "chiamate AI").
--
-- NON contiene: prompt, risposta, confirmationToken, API key, PII cliente.
-- Scrittura fire-and-forget da lib/server/mario-assistant/usage-log.ts:
-- se la tabella non esiste o l'insert fallisce, Mario continua a funzionare.

create table if not exists public.mario_llm_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  request_id uuid null,
  model text not null,
  action text null,                       -- tool_call | clarification | answer | fallback | null
  fallback_used boolean not null default false,
  failed boolean not null default false,  -- errore provider PRIMA di usage affidabile (§16)
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  input_cost_usd numeric(16,10) null,     -- null = tariffe non configurate (§8)
  output_cost_usd numeric(16,10) null,
  total_cost_usd numeric(16,10) null,
  latency_ms integer null
);

create index if not exists mario_llm_usage_tenant_user_created_idx
  on public.mario_llm_usage (tenant_id, user_id, created_at desc);

create index if not exists mario_llm_usage_tenant_created_idx
  on public.mario_llm_usage (tenant_id, created_at desc);

alter table public.mario_llm_usage enable row level security;

-- Il service role (usage-log.ts + usage-summary route) è l'unico accessor;
-- filtra sempre per tenant_id esplicitamente. La policy tenant_read è
-- difesa in profondità, coerente con ai_usage_log.
drop policy if exists "mario_llm_usage_service_role_all" on public.mario_llm_usage;
create policy "mario_llm_usage_service_role_all"
  on public.mario_llm_usage
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "mario_llm_usage_tenant_read" on public.mario_llm_usage;
create policy "mario_llm_usage_tenant_read"
  on public.mario_llm_usage
  for select
  to authenticated
  using (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = mario_llm_usage.tenant_id
      and role in ('admin','operator','supervisor')
  ));
