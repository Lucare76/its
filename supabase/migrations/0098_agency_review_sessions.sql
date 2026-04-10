-- Sessioni di revisione inviate alle agenzie per approvazione/modifica riepiloghi
create table if not exists public.agency_review_sessions (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  token       text        not null unique default encode(gen_random_bytes(24), 'hex'),
  agency_name text        not null,
  report_type text        not null,  -- arrivals_48h | departures_48h | bus_monday | reminder_48h | reminder_24h
  target_date date        not null,
  services    jsonb       not null default '[]',  -- snapshot servizi al momento dell'invio
  status      text        not null default 'pending' check (status in ('pending','approved','modified')),
  modifications jsonb     null,      -- array di {service_id, field, original, modified}
  agency_notes  text      null,      -- nota libera dell'agenzia
  reviewed_at   timestamptz null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '7 days')
);

create index if not exists idx_agency_review_tenant_status
  on public.agency_review_sessions (tenant_id, status, created_at desc);

create index if not exists idx_agency_review_token
  on public.agency_review_sessions (token);

-- RLS: solo service_role scrive, select aperta per token (gestita lato API)
alter table public.agency_review_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'agency_review_sessions'
      and policyname = 'agency_review_service_role_all'
  ) then
    execute $p$
      create policy "agency_review_service_role_all"
        on public.agency_review_sessions for all to service_role
        using (true) with check (true)
    $p$;
  end if;
end$$;
