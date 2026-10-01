-- Migration 0287: finalize_cancellation_request libera anche i posti bus.
--
-- Bug confermato nell'audit "flusso prenotazioni cancellate": la RPC
-- finalize_cancellation_request (ultima versione 0248) cancellava solo gli
-- assignments. Come per cancel_service_practice prima della 0245, le righe
-- tenant_bus_allocations (Rete Bus continentale, 0036) e
-- bus_ischia_dist_allocations (smistamento Ischia, 0107) restavano occupate
-- dopo una cancellazione chiusa dal flusso richieste/agenzia, perche' il
-- servizio viene aggiornato (mai cancellato) e l'ON DELETE CASCADE non scatta.
--
-- 0248 NON viene modificata (gia' applicata): questa migration ridefinisce la
-- funzione con CREATE OR REPLACE, copiando 0248 invariata e aggiungendo SOLO
-- il blocco di pulizia bus. Firma, contratto di ritorno e tutto il resto del
-- comportamento (inclusa la scrittura legacy della penale in
-- agency_quoted_price_cents, fuori scope di questo intervento) restano
-- identici.

create or replace function public.finalize_cancellation_request(
  p_request_id uuid,
  p_tenant_id uuid,
  p_user_id uuid default null,
  p_status text default 'approved',
  p_agency_response text default null,
  p_agency_response_note text default null,
  p_agency_counter_cents integer default null,
  p_penalty_cents integer default null,
  p_penalty_note text default null
)
returns table(service_id uuid, assignments_cleared integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.cancellation_requests%rowtype;
  v_service public.services%rowtype;
  v_now timestamptz := now();
  v_assignments_cleared integer := 0;
  v_penalty_cents integer := coalesce(p_penalty_cents, 0);
  v_status public.service_status;
  v_event_user_id uuid;
  v_notes text;
begin
  if p_status not in ('approved', 'closed') then
    raise exception 'Unsupported cancellation final status: %', p_status
      using errcode = '22023';
  end if;

  select cr.*
    into v_request
  from public.cancellation_requests cr
  where cr.id = p_request_id
    and cr.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Cancellation request not found'
      using errcode = 'P0002';
  end if;

  select s.*
    into v_service
  from public.services s
  where s.id = v_request.service_id
    and s.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Service not found for cancellation request'
      using errcode = 'P0002';
  end if;

  v_penalty_cents := coalesce(p_penalty_cents, v_request.penalty_cents, 0);
  v_event_user_id := coalesce(p_user_id, v_request.requested_by_user_id);

  if v_event_user_id is null then
    select m.user_id
      into v_event_user_id
    from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.role in ('admin', 'operator')
    order by m.created_at asc
    limit 1;
  end if;

  if v_request.cancel_legs = 'both' then
    update public.services s
      set status = 'cancelled'
    where s.id = v_service.id
      and s.tenant_id = p_tenant_id;
    v_status := 'cancelled';
  elsif v_request.cancel_legs = 'arrival' then
    update public.services s
      set arrival_date = null,
          arrival_time = null,
          status = 'new'
    where s.id = v_service.id
      and s.tenant_id = p_tenant_id;
    v_status := 'new';
  else
    update public.services s
      set departure_date = null,
          departure_time = null,
          status = 'new'
    where s.id = v_service.id
      and s.tenant_id = p_tenant_id;
    v_status := 'new';
  end if;

  delete from public.assignments a
  where a.tenant_id = p_tenant_id
    and a.service_id = v_service.id;

  get diagnostics v_assignments_cleared = row_count;

  -- Fix 0287: stessa pulizia allocazioni bus di cancel_service_practice
  -- (0245). Cancellazione totale ('both'): identica a 0245, tutte le righe
  -- del servizio su entrambe le tabelle. Cancellazione di una sola tratta
  -- sul modello legacy a riga unica (arrival_date/departure_date sulla stessa
  -- riga): si libera solo la direzione cancellata, mai il posto della tratta
  -- che resta attiva. Lo smistamento Ischia (0107) e' post-sbarco, cioe'
  -- legato all'arrivo.
  if v_request.cancel_legs = 'both' then
    delete from public.tenant_bus_allocations t
    where t.tenant_id = p_tenant_id
      and t.service_id = v_service.id;

    delete from public.bus_ischia_dist_allocations b
    where b.tenant_id = p_tenant_id
      and b.service_id = v_service.id;
  elsif v_request.cancel_legs = 'arrival' then
    delete from public.tenant_bus_allocations t
    where t.tenant_id = p_tenant_id
      and t.service_id = v_service.id
      and t.direction::text = 'arrival';

    delete from public.bus_ischia_dist_allocations b
    where b.tenant_id = p_tenant_id
      and b.service_id = v_service.id;
  else
    delete from public.tenant_bus_allocations t
    where t.tenant_id = p_tenant_id
      and t.service_id = v_service.id
      and t.direction::text = 'departure';
  end if;

  if v_penalty_cents > 0 then
    update public.services s
      set agency_quoted_price_cents = v_penalty_cents,
          agency_payment_status = 'unpaid'
    where s.id = v_service.id
      and s.tenant_id = p_tenant_id;
  end if;

  update public.cancellation_requests cr
    set status = p_status,
        penalty_cents = v_penalty_cents,
        penalty_note = coalesce(p_penalty_note, cr.penalty_note),
        agency_response = coalesce(p_agency_response, cr.agency_response),
        agency_response_note = coalesce(p_agency_response_note, cr.agency_response_note),
        agency_counter_cents = case
          when p_agency_response = 'counter' then p_agency_counter_cents
          when p_agency_response is not null then null
          else cr.agency_counter_cents
        end,
        agency_responded_at = case
          when p_agency_response is not null then v_now
          else cr.agency_responded_at
        end,
        resolved_at = v_now,
        resolved_by_user_id = coalesce(p_user_id, cr.resolved_by_user_id)
  where cr.id = v_request.id
    and cr.tenant_id = p_tenant_id;

  v_notes := case
    when p_status = 'approved' then 'Cancellazione approvata'
    else 'Cancellazione chiusa da operatore'
  end;

  if v_penalty_cents > 0 then
    v_notes := v_notes || ' | Penale: ' || to_char(v_penalty_cents::numeric / 100, 'FM999999990D00') || ' EUR';
  end if;

  insert into public.status_events (
    tenant_id,
    service_id,
    status,
    by_user_id,
    notes
  )
  values (
    p_tenant_id,
    v_service.id,
    v_status,
    v_event_user_id,
    v_notes
  );

  insert into public.ops_audit_events (
    tenant_id,
    event,
    level,
    user_id,
    service_id,
    details,
    created_at
  )
  values (
    p_tenant_id,
    'assignment_cleared_on_cancellation',
    'info',
    p_user_id,
    v_service.id,
    jsonb_build_object(
      'service_id', v_service.id,
      'assignments_cleared', v_assignments_cleared,
      'happened_at', v_now,
      'request_id', v_request.id,
      'final_status', p_status
    ),
    v_now
  );

  service_id := v_service.id;
  assignments_cleared := v_assignments_cleared;
  return next;
end;
$$;

notify pgrst, 'reload schema';
