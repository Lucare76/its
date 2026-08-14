-- Sprint Performance 8: lock distribuito + cooldown per l'import email IMAP.
--
-- Obiettivo: una sola pipeline reale di import IMAP per tenant/mailbox alla
-- volta, condivisa tra cron, refresh manuale Inbox e qualunque istanza
-- serverless Vercel. L'acquisizione e' atomica tramite row lock Postgres
-- (SELECT ... FOR UPDATE dentro la funzione), non un pattern
-- "SELECT poi UPDATE" a livello applicativo che sarebbe soggetto a race.

create table if not exists public.email_import_locks (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  mailbox text not null default 'default',
  status text not null default 'idle' check (status in ('idle', 'running')),
  started_at timestamptz null,
  lock_expires_at timestamptz null,
  finished_at timestamptz null,
  last_success_at timestamptz null,
  last_error text null,
  updated_at timestamptz not null default timezone('utc'::text, now()),
  primary key (tenant_id, mailbox)
);

alter table public.email_import_locks enable row level security;

-- Nessuna policy per authenticated/anon: la tabella e' gestita solo dal
-- service role (bypassa RLS) tramite le funzioni sotto. Una policy di sola
-- lettura per i ruoli operativi consente diagnosi da SQL editor senza
-- esporre scritture dirette dal client.
drop policy if exists email_import_locks_select_ops on public.email_import_locks;
create policy email_import_locks_select_ops on public.email_import_locks
for select using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- Acquisizione atomica: usa un row lock (FOR UPDATE) sulla riga
-- tenant/mailbox dentro la stessa transazione della funzione, cosi' due
-- chiamate concorrenti si serializzano sulla riga invece di correre su un
-- pattern read-then-write. La seconda chiamata, quando riprende dopo il
-- commit della prima, rilegge lo stato aggiornato e decide correttamente se
-- e' "in corso" o in "cooldown".
create or replace function public.acquire_email_import_lock(
  p_tenant_id uuid,
  p_mailbox text,
  p_ttl_seconds integer,
  p_cooldown_seconds integer,
  p_force boolean default false
)
returns table (
  acquired boolean,
  reason text,
  last_success_at timestamptz,
  lock_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
  v_row public.email_import_locks%rowtype;
begin
  insert into public.email_import_locks (tenant_id, mailbox, status, updated_at)
  values (p_tenant_id, p_mailbox, 'idle', v_now)
  on conflict (tenant_id, mailbox) do nothing;

  select * into v_row
  from public.email_import_locks
  where tenant_id = p_tenant_id and mailbox = p_mailbox
  for update;

  -- Import gia' in corso su un'altra richiesta e lock non scaduto: skip.
  if v_row.status = 'running' and v_row.lock_expires_at is not null and v_row.lock_expires_at > v_now then
    return query select false, 'skipped_in_progress'::text, v_row.last_success_at, v_row.lock_expires_at;
    return;
  end if;

  -- Cooldown: import riuscito di recente e la richiesta non e' forzata: skip.
  if not p_force and v_row.last_success_at is not null
     and v_row.last_success_at > (v_now - make_interval(secs => p_cooldown_seconds)) then
    return query select false, 'skipped_recent'::text, v_row.last_success_at, v_row.lock_expires_at;
    return;
  end if;

  update public.email_import_locks
  set status = 'running',
      started_at = v_now,
      lock_expires_at = v_now + make_interval(secs => p_ttl_seconds),
      finished_at = null,
      updated_at = v_now
  where tenant_id = p_tenant_id and mailbox = p_mailbox;

  return query select true, 'acquired'::text, v_row.last_success_at, (v_now + make_interval(secs => p_ttl_seconds));
end;
$$;

-- Rilascio: sempre chiamato in finally dal chiamante applicativo. Se la
-- Function viene terminata prima di poter chiamare questa funzione (es. kill
-- dopo 120s su Vercel), il lock_expires_at (TTL) impostato in acquire()
-- garantisce comunque che una richiesta successiva possa ripartire senza
-- intervento manuale.
create or replace function public.release_email_import_lock(
  p_tenant_id uuid,
  p_mailbox text,
  p_success boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
begin
  update public.email_import_locks
  set status = 'idle',
      finished_at = v_now,
      lock_expires_at = null,
      last_success_at = case when p_success then v_now else last_success_at end,
      last_error = case when p_success then null else p_error end,
      updated_at = v_now
  where tenant_id = p_tenant_id and mailbox = p_mailbox;
end;
$$;
