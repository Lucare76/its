-- Migration 0288: lock di concorrenza per l'emissione Medmar, per tenant + service_id.
--
-- Problema: l'idempotenza dell'orchestratore (idempotency_key = service_ids
-- ordinati) e il guard "già emesso" (lib/medmar-issuance-guard.ts) non
-- coprono due emissioni SIMULTANEE con gruppi diversi che condividono un
-- servizio ([A,B] e [A]): entrambe superano i controlli prima che una delle
-- due registri l'emissione, ed entrambe arriverebbero a Medmar.
--
-- Soluzione: lease su tabella (stesso pattern di email_import_locks, 0233),
-- NON advisory lock: con il pooler Supabase (transaction mode, PgBouncer/
-- Supavisor) la sessione Postgres non è legata alla richiesta, quindi un
-- advisory lock di sessione può essere rilasciato o ereditato da un'altra
-- richiesta; uno transazionale non sopravvive oltre la singola chiamata RPC.
-- Qui il lock è una riga con PRIMARY KEY (tenant_id, service_id):
--   * acquisizione tutto-o-niente in UNA sola funzione (una transazione):
--     inserimento nell'ordine deterministico dei service_id (niente
--     deadlock), e se anche un solo servizio è occupato le righe già
--     inserite dalla stessa chiamata vengono rimosse prima del commit;
--   * due transazioni concorrenti sulla stessa chiave si serializzano
--     sull'indice unico: la seconda vede il conflitto (ON CONFLICT DO NOTHING)
--     solo dopo il commit della prima;
--   * expires_at (TTL) recupera i lock di un'istanza serverless terminata
--     senza rilascio; i lock scaduti vengono eliminati all'acquisizione;
--   * rilascio solo con il lock_token restituito all'acquisizione.
--
-- NON applicata automaticamente: va eseguita manualmente come le altre.

create table if not exists public.medmar_service_issuance_locks (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  service_id   uuid not null,
  lock_token   uuid not null,
  holder       text null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  primary key (tenant_id, service_id)
);

create index if not exists idx_medmar_service_issuance_locks_token
  on public.medmar_service_issuance_locks (tenant_id, lock_token);

comment on table public.medmar_service_issuance_locks is
  'Lease di concorrenza per emissione Medmar (tenant_id + service_id). Gestita solo dalle RPC acquire/release (service role).';

alter table public.medmar_service_issuance_locks enable row level security;

revoke all on public.medmar_service_issuance_locks from anon;
revoke all on public.medmar_service_issuance_locks from authenticated;
grant select on public.medmar_service_issuance_locks to authenticated;

drop policy if exists medmar_service_issuance_locks_select_ops on public.medmar_service_issuance_locks;
create policy medmar_service_issuance_locks_select_ops on public.medmar_service_issuance_locks
for select to authenticated using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- Acquisizione atomica tutto-o-niente.
create or replace function public.acquire_medmar_service_issuance_locks(
  p_tenant_id uuid,
  p_service_ids uuid[],
  p_ttl_seconds integer,
  p_holder text default null
)
returns table (
  acquired boolean,
  lock_token uuid,
  conflicting_service_ids uuid[],
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
  v_expires timestamptz;
  v_ids uuid[];
  v_id uuid;
  v_inserted integer;
  v_conflicts uuid[] := '{}'::uuid[];
begin
  if p_tenant_id is null or p_service_ids is null or cardinality(p_service_ids) = 0
     or p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'MEDMAR_LOCK_INVALID_INPUT' using errcode = '22023';
  end if;

  -- Ordine deterministico + deduplica: stesso ordine di acquisizione in
  -- tutte le transazioni concorrenti -> nessun deadlock.
  select array_agg(x order by x) into v_ids
  from (select distinct unnest(p_service_ids) as x) s
  where x is not null;

  v_expires := v_now + make_interval(secs => p_ttl_seconds);

  foreach v_id in array v_ids loop
    -- Recupero stale lock: una riga scaduta non protegge più nulla.
    delete from public.medmar_service_issuance_locks l
    where l.tenant_id = p_tenant_id
      and l.service_id = v_id
      and l.expires_at <= v_now;

    insert into public.medmar_service_issuance_locks (tenant_id, service_id, lock_token, holder, acquired_at, expires_at)
    values (p_tenant_id, v_id, v_token, p_holder, v_now, v_expires)
    on conflict (tenant_id, service_id) do nothing;
    get diagnostics v_inserted = row_count;

    if v_inserted = 0 then
      v_conflicts := v_conflicts || v_id;
    end if;
  end loop;

  if cardinality(v_conflicts) > 0 then
    -- Tutto-o-niente: nessun lock parziale resta dopo il commit.
    delete from public.medmar_service_issuance_locks l
    where l.tenant_id = p_tenant_id
      and l.lock_token = v_token;
    return query select false, null::uuid, v_conflicts, null::timestamptz;
    return;
  end if;

  return query select true, v_token, '{}'::uuid[], v_expires;
end;
$$;

-- Rilascio: solo le righe del proprio token (mai quelle di un'altra emissione).
create or replace function public.release_medmar_service_issuance_locks(
  p_tenant_id uuid,
  p_lock_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.medmar_service_issuance_locks l
  where l.tenant_id = p_tenant_id
    and l.lock_token = p_lock_token;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.acquire_medmar_service_issuance_locks(uuid, uuid[], integer, text) from public, anon, authenticated;
revoke all on function public.release_medmar_service_issuance_locks(uuid, uuid) from public, anon, authenticated;
grant execute on function public.acquire_medmar_service_issuance_locks(uuid, uuid[], integer, text) to service_role;
grant execute on function public.release_medmar_service_issuance_locks(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
