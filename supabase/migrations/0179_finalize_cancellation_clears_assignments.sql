-- Finalizza cancellazioni e pulisce gli assignments in modo atomico.
-- Una chiamata RPC e una sola transazione Postgres: se uno step fallisce,
-- anche l'approvazione/chiusura della cancellation_request viene annullata.

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

  select *
    into v_request
  from public.cancellation_requests
  where id = p_request_id
    and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Cancellation request not found'
      using errcode = 'P0002';
  end if;

  select *
    into v_service
  from public.services
  where id = v_request.service_id
    and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Service not found for cancellation request'
      using errcode = 'P0002';
  end if;

  v_penalty_cents := coalesce(p_penalty_cents, v_request.penalty_cents, 0);
  v_event_user_id := coalesce(p_user_id, v_request.requested_by_user_id);

  if v_event_user_id is null then
    select user_id
      into v_event_user_id
    from public.memberships
    where tenant_id = p_tenant_id
      and role in ('admin', 'operator')
    order by created_at asc
    limit 1;
  end if;

  if v_request.cancel_legs = 'both' then
    update public.services
      set status = 'cancelled'
    where id = v_service.id
      and tenant_id = p_tenant_id;
    v_status := 'cancelled';
  elsif v_request.cancel_legs = 'arrival' then
    update public.services
      set arrival_date = null,
          arrival_time = null,
          status = 'new'
    where id = v_service.id
      and tenant_id = p_tenant_id;
    v_status := 'new';
  else
    update public.services
      set departure_date = null,
          departure_time = null,
          status = 'new'
    where id = v_service.id
      and tenant_id = p_tenant_id;
    v_status := 'new';
  end if;

  delete from public.assignments
  where tenant_id = p_tenant_id
    and service_id = v_service.id;

  get diagnostics v_assignments_cleared = row_count;

  if v_penalty_cents > 0 then
    update public.services
      set agency_quoted_price_cents = v_penalty_cents,
          agency_payment_status = 'unpaid'
    where id = v_service.id
      and tenant_id = p_tenant_id;
  end if;

  update public.cancellation_requests
    set status = p_status,
        penalty_cents = v_penalty_cents,
        penalty_note = coalesce(p_penalty_note, penalty_note),
        agency_response = coalesce(p_agency_response, agency_response),
        agency_response_note = coalesce(p_agency_response_note, agency_response_note),
        agency_counter_cents = case
          when p_agency_response = 'counter' then p_agency_counter_cents
          when p_agency_response is not null then null
          else agency_counter_cents
        end,
        agency_responded_at = case
          when p_agency_response is not null then v_now
          else agency_responded_at
        end,
        resolved_at = v_now,
        resolved_by_user_id = coalesce(p_user_id, resolved_by_user_id)
  where id = v_request.id
    and tenant_id = p_tenant_id;

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
