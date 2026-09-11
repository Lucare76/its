-- Fix: cast enum mancanti nelle RPC shuttle schedules introdotte da 0276.
--
-- BUG REALE (trovato da uno smoke test contro produzione, mai dai test unit
-- con fake JS): in Postgres i tipi enum definiti con CREATE TYPE ... AS ENUM
-- non hanno alcun cast implicito né di assegnazione verso/da text — a
-- differenza dei letterali stringa (tipo "unknown"), che il resolver risolve
-- automaticamente contro il tipo di destinazione. Un parametro/espressione
-- gia' TIPIZZATO come text (un parametro di funzione, un coalesce(), ecc.)
-- NON beneficia di questa risoluzione automatica: serve un cast esplicito.
--
-- 0276 castava esplicitamente enum SOLO nell'INSERT di "direction"
-- ((v_row->>'direction')::public.service_direction), lasciando scoperti:
--   1. il confronto `s.direction = p_old_direction` nella CTE "target" di
--      ENTRAMBE le RPC (public.services.direction e' public.service_direction,
--      p_old_direction e' text) — errore reale riprodotto in produzione:
--      "42883: operator does not exist: service_direction = text".
--   2. il confronto `s."time" = p_old_departure_time` nella stessa CTE
--      (public.services."time" e' time, p_old_departure_time e' text) —
--      stessa causa, mai raggiunto perche' il fallimento su (1) blocca prima.
--   3. l'INSERT di "service_type" in patch_shuttle_schedule:
--      coalesce(v_row->>'service_type', 'transfer') e' di tipo text,
--      assegnato alla colonna public.services.service_type
--      (public.service_type enum) — mai raggiunto per lo stesso motivo.
--   4. l'INSERT di "status" in patch_shuttle_schedule:
--      coalesce(v_row->>'status', 'new') e' di tipo text, assegnato alla
--      colonna public.services.status (public.service_status enum) — idem.
--
-- Verificato che NON serve alcun cast per: tenant_id/hotel_id (uuid=uuid),
-- customer_name/vessel/meeting_point (text=text), booking_service_kind
-- (colonna text con CHECK, non un enum — vedi 0019_agency_booking_module.sql),
-- e il confronto `status <> 'new'` nella guardia (il letterale 'new' e' di
-- tipo "unknown": si risolve automaticamente contro l'enum della colonna,
-- nessun parametro/text coinvolto).
--
-- QUESTA MIGRATION NON MODIFICA 0276: la corregge in avanti con
-- CREATE OR REPLACE FUNCTION sulla STESSA firma pubblica (stessi nomi,
-- stessi tipi, stesso ordine di parametro) — l'API TypeScript
-- (app/api/shuttle-schedules/[id]/route.ts) e i permessi EXECUTE gia'
-- concessi (revoke PUBLIC / grant service_role) restano invariati:
-- CREATE OR REPLACE su una funzione con firma identica preserva l'OID e i
-- privilegi gia' assegnati.
--
-- Nessun'altra logica cambia: stessa individuazione righe (FOR UPDATE),
-- stessa guardia operativa su assignments, stesso range date (p_today,
-- invariato — calcolato lato TypeScript come in 0276), stesso
-- deleted_count/deleted_date_from/deleted_date_to/deleted_weekdays/
-- inserted_count in output. Un valore enum non valido (p_old_direction,
-- p_old_departure_time non parsabile come time, o un v_row->>'service_type'/
-- 'status' fuori dai valori ammessi) fa fallire il cast con un errore
-- Postgres reale (invalid input value for enum / invalid input syntax) che
-- annulla l'intera transazione — nessun fallback silenzioso, nessuno stato
-- parziale, esattamente come per qualunque altro errore all'interno di
-- queste funzioni (una funzione plpgsql e' una singola transazione).

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
  -- FIX 0277: direction e time richiedono un cast esplicito (enum/time),
  -- Postgres non applica un cast implicito da text in un confronto "=".
  with target as (
    select s.id, s.date, s.status
    from public.services s
    where s.tenant_id = p_tenant_id
      and s.date >= p_today
      and s.direction = p_old_direction::public.service_direction
      and s."time" = p_old_departure_time::time
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
  -- FIX 0277: service_type e status richiedono un cast esplicito (enum),
  -- coalesce() su un'espressione text non si risolve automaticamente contro
  -- il tipo enum della colonna in un INSERT (a differenza di un letterale).
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
      coalesce(v_row->>'service_type', 'transfer')::public.service_type,
      (v_row->>'direction')::public.service_direction,
      v_row->>'customer_name',
      coalesce((v_row->>'pax')::integer, 1),
      nullif(v_row->>'hotel_id', '')::uuid,
      v_row->>'vessel',
      v_row->>'booking_service_kind',
      nullif(v_row->>'meeting_point', ''),
      coalesce(v_row->>'notes', ''),
      coalesce(v_row->>'phone', ''),
      coalesce(v_row->>'status', 'new')::public.service_status,
      coalesce((v_row->>'is_draft')::boolean, false)
    );
    v_inserted_count := v_inserted_count + 1;
  end loop;

  return query select v_deleted_count, v_deleted_date_from, v_deleted_date_to, v_deleted_weekdays, v_inserted_count;
end;
$$;

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

  -- FIX 0277: stesso cast esplicito di patch_shuttle_schedule (vedi sopra).
  with target as (
    select s.id, s.date, s.status
    from public.services s
    where s.tenant_id = p_tenant_id
      and s.date >= p_today
      and s.direction = p_old_direction::public.service_direction
      and s."time" = p_old_departure_time::time
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

notify pgrst, 'reload schema';
