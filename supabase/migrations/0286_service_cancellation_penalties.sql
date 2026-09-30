-- Migration 0286: storico penali di cancellazione + ripristino prenotazioni cancellate.
--
-- Contesto (audit "flusso prenotazioni cancellate"):
--   * la cancellazione operativa diretta (RPC cancel_service_practice, 0244/0245)
--     non crea alcuna cancellation_request: non esisteva un posto dove
--     registrare una penale per queste prenotazioni;
--   * il vecchio flusso (finalize_cancellation_request) scrive la penale in
--     services.agency_quoted_price_cents, sovrascrivendo il prezzo: il nuovo
--     flusso NON tocca mai agency_quoted_price_cents;
--   * non esisteva alcun ripristino per un servizio gia' 'cancelled'.
--
-- Scelte:
--   * storico append-only: una penale comunicata non viene mai modificata in
--     place. Una modifica crea una nuova riga e marca le precedenti
--     'superseded'; un annullamento marca 'voided'. Mai DELETE.
--   * service_id / linked_service_id SENZA foreign key verso services
--     (stesso principio di service_audit_events, 0278): lo storico economico
--     deve sopravvivere anche a un eventuale hard-delete del servizio.
--   * stato email separato dal salvataggio della penale (email_* per la
--     comunicazione iniziale/rettifica, void_email_* per l'annullamento).
--   * penalty_type 'percentage' supportato a livello dati (percentuale + base
--     + sorgente della base) ma NON ancora esposto da API/UI: la base di
--     calcolo non e' ancora certa (vedi audit).
--   * scritture SOLO via service role (route server-side / RPC security
--     definer); authenticated ha solo SELECT.
--
-- NON applicata automaticamente: va eseguita manualmente (Supabase SQL Editor
-- o psql), come tutte le migration del progetto.

-- ── 1. Tabella ────────────────────────────────────────────────────────────────
create table if not exists public.service_cancellation_penalties (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants(id) on delete cascade,

  -- Servizio di riferimento (tratta su cui l'operatore ha applicato la penale)
  service_id                  uuid not null,
  -- Valorizzato solo con scope='practice': l'altra tratta della pratica A/R.
  -- Una penale 'practice' e' UNA sola riga con UN solo importo: mai
  -- duplicata sulle due tratte.
  linked_service_id           uuid null,
  scope                       text not null check (scope in ('leg', 'practice')),
  cancellation_request_id     uuid null references public.cancellation_requests(id) on delete set null,

  penalty_type                text not null check (penalty_type in ('none', 'percentage', 'fixed')),
  penalty_percentage          numeric(5,2) null check (penalty_percentage is null or (penalty_percentage > 0 and penalty_percentage <= 100)),
  base_amount_cents           integer null check (base_amount_cents is null or base_amount_cents >= 0),
  base_amount_source          text null,
  penalty_amount_cents        integer not null default 0 check (penalty_amount_cents >= 0),
  penalty_notes               text null,

  status                      text not null default 'active' check (status in ('active', 'superseded', 'voided')),
  supersedes_ids              uuid[] not null default '{}'::uuid[],
  superseded_by_id            uuid null references public.service_cancellation_penalties(id) on delete set null,
  superseded_at               timestamptz null,

  applied_at                  timestamptz not null default now(),
  applied_by_user_id          uuid null references auth.users(id) on delete set null,
  applied_by_name             text null,
  applied_by_role             text null,

  voided_at                   timestamptz null,
  voided_by_user_id           uuid null references auth.users(id) on delete set null,
  voided_by_name              text null,
  void_reason                 text null,

  -- Comunicazione della penale (prima comunicazione o rettifica)
  email_kind                  text not null default 'initial' check (email_kind in ('initial', 'rectification')),
  email_status                text not null default 'pending' check (email_status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'no_recipient', 'not_required')),
  email_recipient             text null,
  email_sent_at               timestamptz null,
  email_attempts              integer not null default 0 check (email_attempts >= 0),
  email_last_attempt_at       timestamptz null,
  email_last_error            text null,

  -- Comunicazione dell'annullamento (solo se status='voided')
  void_email_status           text null check (void_email_status is null or void_email_status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'no_recipient', 'not_required')),
  void_email_recipient        text null,
  void_email_sent_at          timestamptz null,
  void_email_attempts         integer not null default 0 check (void_email_attempts >= 0),
  void_email_last_attempt_at  timestamptz null,
  void_email_last_error       text null,

  idempotency_key             text not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint service_cancellation_penalties_idempotency_unique unique (tenant_id, idempotency_key),
  constraint service_cancellation_penalties_scope_linked check (
    (scope = 'leg' and linked_service_id is null)
    or (scope = 'practice' and linked_service_id is not null and linked_service_id <> service_id)
  ),
  constraint service_cancellation_penalties_type_consistency check (
    (penalty_type = 'none' and penalty_amount_cents = 0 and penalty_percentage is null)
    or (penalty_type = 'fixed' and penalty_amount_cents > 0 and penalty_percentage is null)
    or (penalty_type = 'percentage' and penalty_percentage is not null
        and base_amount_cents is not null and base_amount_source is not null)
  ),
  constraint service_cancellation_penalties_void_consistency check (
    (status = 'voided') = (voided_at is not null)
  )
);

comment on table public.service_cancellation_penalties is
  'Storico penali di cancellazione (append-only: superseded/voided, mai update in place dei dati economici). Non tocca services.agency_quoted_price_cents.';

-- Al massimo UNA penale attiva per tratta, sia come service_id sia come
-- linked_service_id (penale di pratica). Il caso incrociato (penale di
-- tratta su B + penale di pratica A<->B) e' escluso dalla RPC sotto, che
-- serializza sulle righe services con FOR UPDATE.
create unique index if not exists service_cancellation_penalties_one_active_service
  on public.service_cancellation_penalties (tenant_id, service_id)
  where status = 'active';

create unique index if not exists service_cancellation_penalties_one_active_linked
  on public.service_cancellation_penalties (tenant_id, linked_service_id)
  where status = 'active' and linked_service_id is not null;

create index if not exists idx_service_cancellation_penalties_tenant_service
  on public.service_cancellation_penalties (tenant_id, service_id, created_at desc);

create index if not exists idx_service_cancellation_penalties_tenant_linked
  on public.service_cancellation_penalties (tenant_id, linked_service_id, created_at desc)
  where linked_service_id is not null;

create or replace function public.set_service_cancellation_penalties_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists service_cancellation_penalties_updated_at on public.service_cancellation_penalties;
create trigger service_cancellation_penalties_updated_at
  before update on public.service_cancellation_penalties
  for each row execute function public.set_service_cancellation_penalties_updated_at();

-- ── 2. RLS / GRANT (stesso pattern di service_audit_events, 0278) ────────────
alter table public.service_cancellation_penalties enable row level security;

revoke all on public.service_cancellation_penalties from anon;
revoke all on public.service_cancellation_penalties from authenticated;
grant select on public.service_cancellation_penalties to authenticated;

drop policy if exists service_cancellation_penalties_select on public.service_cancellation_penalties;
create policy service_cancellation_penalties_select on public.service_cancellation_penalties
for select to authenticated using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator', 'supervisor')
);

-- ── 3. RPC apply_cancellation_penalty ────────────────────────────────────────
-- Registra una nuova versione della penale in modo atomico e idempotente.
-- Codici errore (nel messaggio, mappati dalla route):
--   PENALTY_INVALID_INPUT, PENALTY_SERVICE_NOT_FOUND, PENALTY_SERVICE_NOT_CANCELLED,
--   PENALTY_NO_LINKED_SERVICE, PENALTY_STALE_STATE, PENALTY_RECTIFICATION_CONFIRMATION_REQUIRED
create or replace function public.apply_cancellation_penalty(
  p_tenant_id uuid,
  p_service_id uuid,
  p_scope text,
  p_penalty_type text,
  p_amount_cents integer,
  p_percentage numeric default null,
  p_base_amount_cents integer default null,
  p_base_amount_source text default null,
  p_notes text default null,
  p_idempotency_key text default null,
  p_expected_active_ids uuid[] default '{}'::uuid[],
  p_confirm_rectification boolean default false,
  p_user_id uuid default null,
  p_user_name text default null,
  p_user_role text default null
)
returns table(
  penalty_id uuid,
  replayed boolean,
  out_email_kind text,
  out_email_status text,
  superseded_ids uuid[],
  previous_communicated boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_linked public.services%rowtype;
  v_existing public.service_cancellation_penalties%rowtype;
  v_target_ids uuid[];
  v_active_ids uuid[];
  v_communicated boolean := false;
  v_email_kind text;
  v_email_status text;
  v_new_id uuid;
  v_now timestamptz := now();
begin
  if p_scope not in ('leg', 'practice')
     or p_penalty_type not in ('none', 'percentage', 'fixed')
     or p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'PENALTY_INVALID_INPUT' using errcode = '22023';
  end if;

  select s.* into v_service
  from public.services s
  where s.id = p_service_id and s.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PENALTY_SERVICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotenza DOPO il lock sul servizio: due richieste concorrenti con la
  -- stessa chiave si serializzano qui e la seconda vede la riga della prima.
  select p.* into v_existing
  from public.service_cancellation_penalties p
  where p.tenant_id = p_tenant_id and p.idempotency_key = p_idempotency_key;
  if found then
    penalty_id := v_existing.id;
    replayed := true;
    out_email_kind := v_existing.email_kind;
    out_email_status := v_existing.email_status;
    superseded_ids := v_existing.supersedes_ids;
    previous_communicated := v_existing.email_kind = 'rectification';
    return next;
    return;
  end if;

  if v_service.status::text <> 'cancelled' then
    raise exception 'PENALTY_SERVICE_NOT_CANCELLED' using errcode = 'P0001';
  end if;

  v_target_ids := array[v_service.id];

  if p_scope = 'practice' then
    if v_service.linked_service_id is null then
      raise exception 'PENALTY_NO_LINKED_SERVICE' using errcode = 'P0001';
    end if;
    select s.* into v_linked
    from public.services s
    where s.id = v_service.linked_service_id and s.tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'PENALTY_NO_LINKED_SERVICE' using errcode = 'P0001';
    end if;
    if v_linked.status::text <> 'cancelled' then
      raise exception 'PENALTY_SERVICE_NOT_CANCELLED' using errcode = 'P0001';
    end if;
    v_target_ids := array[v_service.id, v_linked.id];
  end if;

  -- Penali attive che toccano le tratte coinvolte (come service_id o come
  -- linked_service_id di una penale di pratica).
  select coalesce(array_agg(p.id order by p.id), '{}'::uuid[]),
         coalesce(bool_or(p.email_status in ('sent', 'sending')), false)
    into v_active_ids, v_communicated
  from public.service_cancellation_penalties p
  where p.tenant_id = p_tenant_id
    and p.status = 'active'
    and (p.service_id = any(v_target_ids) or p.linked_service_id = any(v_target_ids));

  -- Protezione da modifiche concorrenti: l'operatore deve aver visto
  -- esattamente le penali attive che stanno per essere sostituite.
  if not (v_active_ids @> coalesce(p_expected_active_ids, '{}'::uuid[])
          and coalesce(p_expected_active_ids, '{}'::uuid[]) @> v_active_ids) then
    raise exception 'PENALTY_STALE_STATE' using errcode = 'P0001';
  end if;

  if v_communicated and not coalesce(p_confirm_rectification, false) then
    raise exception 'PENALTY_RECTIFICATION_CONFIRMATION_REQUIRED' using errcode = 'P0001';
  end if;

  v_email_kind := case when v_communicated then 'rectification' else 'initial' end;
  -- "Nessuna penale" mai comunicata prima: nessuna email necessaria.
  -- Se invece sostituisce una penale gia' comunicata, la rettifica e' obbligatoria.
  v_email_status := case
    when p_penalty_type = 'none' and not v_communicated then 'not_required'
    else 'pending'
  end;

  update public.service_cancellation_penalties p
    set status = 'superseded',
        superseded_at = v_now
  where p.tenant_id = p_tenant_id
    and p.id = any(v_active_ids);

  insert into public.service_cancellation_penalties (
    tenant_id, service_id, linked_service_id, scope,
    penalty_type, penalty_percentage, base_amount_cents, base_amount_source,
    penalty_amount_cents, penalty_notes,
    status, supersedes_ids,
    applied_at, applied_by_user_id, applied_by_name, applied_by_role,
    email_kind, email_status, idempotency_key
  ) values (
    p_tenant_id,
    v_service.id,
    case when p_scope = 'practice' then v_linked.id else null end,
    p_scope,
    p_penalty_type,
    case when p_penalty_type = 'percentage' then p_percentage else null end,
    p_base_amount_cents,
    p_base_amount_source,
    case when p_penalty_type = 'none' then 0 else coalesce(p_amount_cents, 0) end,
    nullif(trim(coalesce(p_notes, '')), ''),
    'active',
    v_active_ids,
    v_now, p_user_id, p_user_name, p_user_role,
    v_email_kind, v_email_status, p_idempotency_key
  )
  returning id into v_new_id;

  update public.service_cancellation_penalties p
    set superseded_by_id = v_new_id
  where p.tenant_id = p_tenant_id
    and p.id = any(v_active_ids);

  insert into public.ops_audit_events (tenant_id, event, level, user_id, service_id, details, created_at)
  values (
    p_tenant_id,
    case when cardinality(v_active_ids) > 0 then 'cancellation_penalty_modified' else 'cancellation_penalty_applied' end,
    'info',
    p_user_id,
    v_service.id,
    jsonb_build_object(
      'penalty_id', v_new_id,
      'scope', p_scope,
      'service_ids', to_jsonb(v_target_ids),
      'penalty_type', p_penalty_type,
      'penalty_amount_cents', case when p_penalty_type = 'none' then 0 else coalesce(p_amount_cents, 0) end,
      'superseded_ids', to_jsonb(v_active_ids),
      'previous_communicated', v_communicated,
      'email_kind', v_email_kind,
      'happened_at', v_now
    ),
    v_now
  );

  penalty_id := v_new_id;
  replayed := false;
  out_email_kind := v_email_kind;
  out_email_status := v_email_status;
  superseded_ids := v_active_ids;
  previous_communicated := v_communicated;
  return next;
end;
$$;

-- ── 4. RPC restore_cancelled_service ─────────────────────────────────────────
-- Riporta a 'new' le tratte cancellate richieste. NON ricrea assignments,
-- autisti, mezzi, allocazioni bus/navette ne' biglietti Medmar: il servizio
-- torna nelle liste operative come "da assegnare". Eventuali assignments /
-- allocazioni bus rimasti appesi a un servizio cancellato (percorsi legacy
-- che non li pulivano, es. /api/agency/cancel) vengono rimossi, cosi' il
-- servizio ripristinato non si porta dietro posti "fantasma" e non possono
-- nascere doppie allocazioni. medmar_ticket_sent_at NON viene toccato.
--
-- p_penalty_action: 'none' (default: fallisce se esiste una penale attiva),
--                   'void' (annulla la penale attiva e ripristina),
--                   'keep' (ripristina mantenendo la penale attiva).
-- Codici errore: RESTORE_INVALID_INPUT, RESTORE_SERVICE_NOT_FOUND, RESTORE_ACTIVE_PENALTY
create or replace function public.restore_cancelled_service(
  p_tenant_id uuid,
  p_service_id uuid,
  p_scope text,
  p_penalty_action text default 'none',
  p_void_reason text default null,
  p_user_id uuid default null,
  p_user_name text default null
)
returns table(
  out_service_id uuid,
  previous_status text,
  new_status text,
  stale_assignments_cleared integer,
  stale_bus_allocations_cleared integer,
  voided_penalty_ids uuid[],
  kept_penalty_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_linked public.services%rowtype;
  v_candidate_ids uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
  v_active_ids uuid[];
  v_voided uuid[] := '{}'::uuid[];
  v_kept uuid[] := '{}'::uuid[];
  v_id uuid;
  v_assignments integer;
  v_tenant_bus integer;
  v_ischia_bus integer;
  v_now timestamptz := now();
begin
  if p_scope not in ('leg', 'practice')
     or coalesce(p_penalty_action, 'none') not in ('none', 'void', 'keep') then
    raise exception 'RESTORE_INVALID_INPUT' using errcode = '22023';
  end if;

  select s.* into v_service
  from public.services s
  where s.id = p_service_id and s.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'RESTORE_SERVICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_candidate_ids := array[v_service.id];
  if v_service.status::text = 'cancelled' then
    v_target_ids := array[v_service.id];
  end if;

  if p_scope = 'practice' and v_service.linked_service_id is not null then
    select s.* into v_linked
    from public.services s
    where s.id = v_service.linked_service_id and s.tenant_id = p_tenant_id
    for update;
    if found then
      v_candidate_ids := v_candidate_ids || v_linked.id;
      if v_linked.status::text = 'cancelled' then
        v_target_ids := v_target_ids || v_linked.id;
      end if;
    end if;
  end if;

  -- Idempotente: nessuna tratta ancora cancellata -> nessuna modifica.
  if cardinality(v_target_ids) = 0 then
    return;
  end if;

  select coalesce(array_agg(p.id order by p.id), '{}'::uuid[])
    into v_active_ids
  from public.service_cancellation_penalties p
  where p.tenant_id = p_tenant_id
    and p.status = 'active'
    and (p.service_id = any(v_target_ids) or p.linked_service_id = any(v_target_ids));

  if cardinality(v_active_ids) > 0 then
    if coalesce(p_penalty_action, 'none') = 'none' then
      raise exception 'RESTORE_ACTIVE_PENALTY' using errcode = 'P0001';
    elsif p_penalty_action = 'void' then
      update public.service_cancellation_penalties p
        set status = 'voided',
            voided_at = v_now,
            voided_by_user_id = p_user_id,
            voided_by_name = p_user_name,
            void_reason = nullif(trim(coalesce(p_void_reason, '')), ''),
            -- Comunicazione di annullamento solo se una penale reale (non
            -- "Nessuna penale") era stata comunicata all'agenzia.
            void_email_status = case
              when p.email_status in ('sent', 'sending') and p.penalty_type <> 'none' then 'pending'
              else 'not_required'
            end
      where p.tenant_id = p_tenant_id
        and p.id = any(v_active_ids);
      v_voided := v_active_ids;
    else
      v_kept := v_active_ids;
    end if;
  end if;

  foreach v_id in array v_target_ids loop
    update public.services s
      set status = 'new'
    where s.id = v_id and s.tenant_id = p_tenant_id;

    delete from public.assignments a
    where a.tenant_id = p_tenant_id and a.service_id = v_id;
    get diagnostics v_assignments = row_count;

    delete from public.tenant_bus_allocations t
    where t.tenant_id = p_tenant_id and t.service_id = v_id;
    get diagnostics v_tenant_bus = row_count;

    delete from public.bus_ischia_dist_allocations b
    where b.tenant_id = p_tenant_id and b.service_id = v_id;
    get diagnostics v_ischia_bus = row_count;

    insert into public.status_events (tenant_id, service_id, status, by_user_id, notes)
    values (
      p_tenant_id,
      v_id,
      'new',
      p_user_id,
      concat_ws(
        ' | ',
        'Prenotazione ripristinata da cancellazione (restore_booking) — da riassegnare/verificare',
        case when cardinality(v_voided) > 0 then 'Penale annullata' end,
        case when cardinality(v_kept) > 0 then 'Penale mantenuta' end
      )
    );

    out_service_id := v_id;
    previous_status := 'cancelled';
    new_status := 'new';
    stale_assignments_cleared := v_assignments;
    stale_bus_allocations_cleared := v_tenant_bus + v_ischia_bus;
    voided_penalty_ids := v_voided;
    kept_penalty_ids := v_kept;
    return next;
  end loop;

  insert into public.ops_audit_events (tenant_id, event, level, user_id, service_id, details, created_at)
  values (
    p_tenant_id,
    'service_restored_from_cancellation',
    'info',
    p_user_id,
    p_service_id,
    jsonb_build_object(
      'action', 'restore_booking',
      'scope', p_scope,
      'service_ids', to_jsonb(v_target_ids),
      'previous_status', 'cancelled',
      'new_status', 'new',
      'penalty_action', coalesce(p_penalty_action, 'none'),
      'voided_penalty_ids', to_jsonb(v_voided),
      'kept_penalty_ids', to_jsonb(v_kept),
      'happened_at', v_now
    ),
    v_now
  );

  if cardinality(v_voided) > 0 then
    insert into public.ops_audit_events (tenant_id, event, level, user_id, service_id, details, created_at)
    values (
      p_tenant_id,
      'cancellation_penalty_voided',
      'info',
      p_user_id,
      p_service_id,
      jsonb_build_object('penalty_ids', to_jsonb(v_voided), 'reason', p_void_reason, 'happened_at', v_now),
      v_now
    );
  end if;
end;
$$;

revoke all on function public.apply_cancellation_penalty(uuid, uuid, text, text, integer, numeric, integer, text, text, text, uuid[], boolean, uuid, text, text) from public, anon, authenticated;
revoke all on function public.restore_cancelled_service(uuid, uuid, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_cancellation_penalty(uuid, uuid, text, text, integer, numeric, integer, text, text, text, uuid[], boolean, uuid, text, text) to service_role;
grant execute on function public.restore_cancelled_service(uuid, uuid, text, text, text, uuid, text) to service_role;

notify pgrst, 'reload schema';
