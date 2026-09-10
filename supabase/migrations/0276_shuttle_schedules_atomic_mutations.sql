-- Shuttle schedules PATCH/DELETE atomiche (P1 tecnico).
--
-- PROBLEMA: app/api/shuttle-schedules/[id]/route.ts oggi esegue PATCH come
-- una sequenza di chiamate Supabase SEPARATE (guardia operativa -> DELETE
-- delle righe future -> INSERT delle righe rigenerate, in chunk da 500) e
-- DELETE come (guardia operativa -> DELETE). Se un passaggio intermedio
-- fallisce (rete, timeout, un chunk su piu' che va in errore), il DB resta
-- in uno stato parziale: le righe vecchie sono gia' state cancellate ma le
-- nuove non sono (ancora) scritte, oppure la guardia e' stata verificata ma
-- nel frattempo un'altra richiesta ha reso operativa una riga che la DELETE
-- cancella comunque (race check-then-act). Nessuna delle chiamate Supabase
-- esistenti gira dentro una transazione Postgres unica.
--
-- SOLUZIONE: due funzioni RPC dedicate, ciascuna una SOLA transazione
-- Postgres (una funzione plpgsql e' per natura atomica: o l'intero corpo
-- commit, o va tutto in rollback al primo errore/eccezione):
--   - public.patch_shuttle_schedule: individua le righe FUTURE che
--     corrispondono all'identita' attuale della navetta, applica la stessa
--     guardia operativa di oggi (nessuna riga con status <> 'new', nessuna
--     riga con un assignment), cancella e reinserisce le righe rigenerate
--     — tutto in un'unica transazione.
--   - public.delete_shuttle_schedule: stessa individuazione + guardia +
--     cancellazione, senza reinserimento.
--
-- Il calcolo del range di date/orario/timezone (Europe/Rome, inclusivita'
-- start/end, filtro giorni settimana, "mai rigenerare corse nel passato")
-- RESTA in TypeScript (lib/shuttle-schedules.ts, gia' testato in
-- tests/unit/shuttle-schedules-*.test.ts): la RPC riceve le righe GIA'
-- calcolate come JSONB e si occupa solo della parte che deve essere
-- atomica a livello di database (individuazione + guardia + delete +
-- insert). Reimplementare la logica di date/timezone in SQL avrebbe
-- introdotto una seconda fonte di verita' per una logica gia' collaudata,
-- senza necessita': l'atomicita' richiesta riguarda le operazioni sul DB,
-- non il calcolo puro delle date.
--
-- SICUREZZA:
--   - SECURITY DEFINER + search_path fissato a 'public' (stesso pattern
--     gia' in uso in questo progetto per le RPC di mutazione atomica, vedi
--     0244_cancel_service_practice_rpc.sql): necessario perche' la funzione
--     deve poter scrivere su public.services indipendentemente dalle policy
--     RLS della tabella, esattamente come fa gia' oggi il client admin
--     (service role) da cui viene chiamata.
--   - Il tenant non e' mai implicito: ogni query filtra esplicitamente per
--     p_tenant_id (mai una fiducia nella sola RLS, difesa in profondita' —
--     stesso principio di cancel_service_practice). p_tenant_id viene
--     passato dal server con auth.membership.tenant_id (mai dal body della
--     richiesta HTTP) ed e' SEMPRE il valore usato per le righe scritte:
--     qualunque tenant_id eventualmente presente nel payload JSONB
--     (p_new_rows) viene ignorato, mai propagato alle INSERT.
--   - EXECUTE revocato a PUBLIC e concesso solo a service_role: queste RPC
--     sono pensate per essere chiamate esclusivamente dal server con la
--     service role key (mai da un client anon/authenticated), quindi non
--     devono essere raggiungibili via PostgREST da un chiamante che
--     controlli p_tenant_id a piacere.

-- ─── PATCH ──────────────────────────────────────────────────────────────

create or replace function public.patch_shuttle_schedule(
  p_tenant_id uuid,
  p_today date,
  p_old_direction text,
  p_old_departure_time text,
  p_old_customer_name text,
  p_old_vessel text,
  p_old_hotel_id uuid,
  p_old_meeting_point text,
  p_old_booking_service_kind text,
  p_new_rows jsonb
)
returns table(
  deleted_count integer,
  deleted_date_from date,
  deleted_date_to date,
  deleted_weekdays integer[],
  inserted_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_ids uuid[];
  v_deleted_date_from date;
  v_deleted_date_to date;
  v_deleted_weekdays integer[];
  v_blocked_status boolean;
  v_blocked_assignment boolean;
  v_deleted_count integer := 0;
  v_inserted_count integer := 0;
  v_row jsonb;
begin
  if p_tenant_id is null then
    raise exception 'p_tenant_id e'' obbligatorio' using errcode = '22023';
  end if;
  if p_today is null then
    raise exception 'p_today e'' obbligatorio' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_new_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'p_new_rows deve essere un array JSON' using errcode = '22023';
  end if;

  -- 1) individua (e blocca con FOR UPDATE) le righe FUTURE che
  -- corrispondono all'identita' ATTUALE (prima della patch) della navetta.
  -- Stessi filtri di hasOperationalFutureServices/deleteMatchingFutureServices
  -- in app/api/shuttle-schedules/[id]/route.ts: hotel_id e meeting_point
  -- sono confrontati IS NOT DISTINCT FROM (vincolano sempre, anche a NULL);
  -- booking_service_kind e' filtrato solo se valorizzato (stesso
  -- comportamento asimmetrico gia' esistente lato applicativo).
  with target as (
    select s.id, s.date, s.status
    from public.services s
    where s.tenant_id = p_tenant_id
      and s.date >= p_today
      and s.direction = p_old_direction
      and s."time" = p_old_departure_time
      and s.customer_name = p_old_customer_name
      and s.vessel = p_old_vessel
      and s.hotel_id is not distinct from p_old_hotel_id
      and s.meeting_point is not distinct from p_old_meeting_point
      and (
        p_old_booking_service_kind is null
        or p_old_booking_service_kind = ''
        or s.booking_service_kind = p_old_booking_service_kind
      )
    for update
  )
  select
    coalesce(array_agg(id), array[]::uuid[]),
    min(date),
    max(date),
    coalesce(array_agg(distinct extract(dow from date)::int), array[]::integer[]),
    coalesce(bool_or(status <> 'new'), false)
  into v_target_ids, v_deleted_date_from, v_deleted_date_to, v_deleted_weekdays, v_blocked_status
  from target;

  -- 2) guardia operativa: nessuna riga futura gia' lavorata/assegnata.
  -- Stessa transazione della delete/insert che segue: elimina la finestra
  -- di race check-then-act che esiste oggi tra la query di guardia (fatta
  -- lato app) e la DELETE (chiamata Supabase separata).
  select exists(
    select 1 from public.assignments a
    where a.tenant_id = p_tenant_id and a.service_id = any(v_target_ids)
  ) into v_blocked_assignment;

  if v_blocked_status or v_blocked_assignment then
    raise exception 'SHUTTLE_HAS_OPERATIONAL_SERVICES' using errcode = 'P0001';
  end if;

  -- 3) cancella le righe individuate.
  delete from public.services where id = any(v_target_ids);
  get diagnostics v_deleted_count = row_count;

  -- 4) reinserisce le righe rigenerate (gia' calcolate lato applicativo).
  -- tenant_id NON viene mai letto da v_row: e' sempre p_tenant_id, cosi'
  -- un tenant_id eventualmente presente nel JSONB (payload malevolo o bug
  -- del chiamante) non puo' mai far scrivere righe per un altro tenant.
  for v_row in select * from jsonb_array_elements(coalesce(p_new_rows, '[]'::jsonb))
  loop
    if v_row->>'date' is null
      or v_row->>'direction' is null
      or v_row->>'customer_name' is null
      or v_row->>'vessel' is null
      or v_row->>'time' is null
    then
      raise exception 'p_new_rows: riga senza uno dei campi obbligatori (date/time/direction/customer_name/vessel)'
        using errcode = '22023';
    end if;

    insert into public.services (
      tenant_id, date, "time", service_type, direction, customer_name, pax,
      hotel_id, vessel, booking_service_kind, meeting_point, notes, phone, status, is_draft
    ) values (
      p_tenant_id,
      (v_row->>'date')::date,
      (v_row->>'time')::time,
      coalesce(v_row->>'service_type', 'transfer'),
      (v_row->>'direction')::public.service_direction,
      v_row->>'customer_name',
      coalesce((v_row->>'pax')::integer, 1),
      nullif(v_row->>'hotel_id', '')::uuid,
      v_row->>'vessel',
      v_row->>'booking_service_kind',
      nullif(v_row->>'meeting_point', ''),
      coalesce(v_row->>'notes', ''),
      coalesce(v_row->>'phone', ''),
      coalesce(v_row->>'status', 'new'),
      coalesce((v_row->>'is_draft')::boolean, false)
    );
    v_inserted_count := v_inserted_count + 1;
  end loop;

  return query select v_deleted_count, v_deleted_date_from, v_deleted_date_to, v_deleted_weekdays, v_inserted_count;
end;
$$;

revoke all on function public.patch_shuttle_schedule(
  uuid, date, text, text, text, text, uuid, text, text, jsonb
) from public;
grant execute on function public.patch_shuttle_schedule(
  uuid, date, text, text, text, text, uuid, text, text, jsonb
) to service_role;

-- ─── DELETE ─────────────────────────────────────────────────────────────

create or replace function public.delete_shuttle_schedule(
  p_tenant_id uuid,
  p_today date,
  p_old_direction text,
  p_old_departure_time text,
  p_old_customer_name text,
  p_old_vessel text,
  p_old_hotel_id uuid,
  p_old_meeting_point text,
  p_old_booking_service_kind text
)
returns table(
  deleted_count integer,
  deleted_date_from date,
  deleted_date_to date,
  deleted_weekdays integer[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_ids uuid[];
  v_deleted_date_from date;
  v_deleted_date_to date;
  v_deleted_weekdays integer[];
  v_blocked_status boolean;
  v_blocked_assignment boolean;
  v_deleted_count integer := 0;
begin
  if p_tenant_id is null then
    raise exception 'p_tenant_id e'' obbligatorio' using errcode = '22023';
  end if;
  if p_today is null then
    raise exception 'p_today e'' obbligatorio' using errcode = '22023';
  end if;

  with target as (
    select s.id, s.date, s.status
    from public.services s
    where s.tenant_id = p_tenant_id
      and s.date >= p_today
      and s.direction = p_old_direction
      and s."time" = p_old_departure_time
      and s.customer_name = p_old_customer_name
      and s.vessel = p_old_vessel
      and s.hotel_id is not distinct from p_old_hotel_id
      and s.meeting_point is not distinct from p_old_meeting_point
      and (
        p_old_booking_service_kind is null
        or p_old_booking_service_kind = ''
        or s.booking_service_kind = p_old_booking_service_kind
      )
    for update
  )
  select
    coalesce(array_agg(id), array[]::uuid[]),
    min(date),
    max(date),
    coalesce(array_agg(distinct extract(dow from date)::int), array[]::integer[]),
    coalesce(bool_or(status <> 'new'), false)
  into v_target_ids, v_deleted_date_from, v_deleted_date_to, v_deleted_weekdays, v_blocked_status
  from target;

  select exists(
    select 1 from public.assignments a
    where a.tenant_id = p_tenant_id and a.service_id = any(v_target_ids)
  ) into v_blocked_assignment;

  if v_blocked_status or v_blocked_assignment then
    raise exception 'SHUTTLE_HAS_OPERATIONAL_SERVICES' using errcode = 'P0001';
  end if;

  delete from public.services where id = any(v_target_ids);
  get diagnostics v_deleted_count = row_count;

  return query select v_deleted_count, v_deleted_date_from, v_deleted_date_to, v_deleted_weekdays;
end;
$$;

revoke all on function public.delete_shuttle_schedule(
  uuid, date, text, text, text, text, uuid, text, text
) from public;
grant execute on function public.delete_shuttle_schedule(
  uuid, date, text, text, text, text, uuid, text, text
) to service_role;

notify pgrst, 'reload schema';
