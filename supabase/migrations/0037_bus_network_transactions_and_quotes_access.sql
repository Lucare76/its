alter table public.tenant_bus_allocation_moves
  add column if not exists customer_name text null,
  add column if not exists customer_phone text null,
  add column if not exists hotel_name text null,
  add column if not exists source_bus_label text null,
  add column if not exists target_bus_label text null,
  add column if not exists allocation_snapshot_pax integer null check (allocation_snapshot_pax is null or allocation_snapshot_pax between 1 and 120),
  add column if not exists moved_full_allocation boolean not null default false;

create or replace function public.allocate_bus_service(
  p_tenant_id uuid,
  p_service_id uuid,
  p_bus_line_id uuid,
  p_bus_unit_id uuid,
  p_stop_id uuid,
  p_stop_name text,
  p_direction public.service_direction,
  p_pax_assigned integer,
  p_notes text,
  p_created_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_line public.tenant_bus_lines%rowtype;
  v_unit public.tenant_bus_units%rowtype;
  v_stop public.tenant_bus_line_stops%rowtype;
  v_existing_allocation_id uuid;
  v_target_bus_pax integer;
  v_inserted_id uuid;
begin
  if p_pax_assigned is null or p_pax_assigned <= 0 or p_pax_assigned > 120 then
    raise exception 'Numero pax non valido.';
  end if;

  select *
  into v_service
  from public.services
  where id = p_service_id
    and tenant_id = p_tenant_id;

  if not found then
    raise exception 'Servizio non trovato.';
  end if;

  if v_service.direction <> p_direction then
    raise exception 'Direzione servizio e fermata non coerenti.';
  end if;

  select *
  into v_line
  from public.tenant_bus_lines
  where id = p_bus_line_id
    and tenant_id = p_tenant_id
    and active = true;

  if not found then
    raise exception 'Linea bus non trovata.';
  end if;

  select *
  into v_unit
  from public.tenant_bus_units
  where id = p_bus_unit_id
    and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Bus non trovato.';
  end if;

  if v_unit.bus_line_id <> p_bus_line_id then
    raise exception 'Il bus selezionato non appartiene alla linea scelta.';
  end if;

  if v_unit.status in ('closed', 'completed') then
    raise exception 'Bus chiuso o completato: nessuna nuova prenotazione consentita.';
  end if;

  select *
  into v_stop
  from public.tenant_bus_line_stops
  where id = p_stop_id
    and tenant_id = p_tenant_id
    and active = true;

  if not found then
    raise exception 'Fermata non trovata.';
  end if;

  if v_stop.bus_line_id <> p_bus_line_id then
    raise exception 'La fermata selezionata non appartiene alla linea scelta.';
  end if;

  if v_stop.direction <> p_direction then
    raise exception 'La fermata selezionata non appartiene alla direzione scelta.';
  end if;

  if coalesce(nullif(trim(p_stop_name), ''), '') <> v_stop.stop_name then
    raise exception 'Nome fermata incoerente con lo stop selezionato.';
  end if;

  select id
  into v_existing_allocation_id
  from public.tenant_bus_allocations
  where tenant_id = p_tenant_id
    and service_id = p_service_id
  limit 1;

  if v_existing_allocation_id is not null then
    raise exception 'Il servizio e'' gia allocato a un bus.';
  end if;

  select coalesce(sum(pax_assigned), 0)
  into v_target_bus_pax
  from public.tenant_bus_allocations
  where tenant_id = p_tenant_id
    and bus_unit_id = p_bus_unit_id;

  if v_target_bus_pax + p_pax_assigned > v_unit.capacity then
    raise exception 'Capienza bus superata.';
  end if;

  insert into public.tenant_bus_allocations (
    tenant_id,
    service_id,
    bus_line_id,
    bus_unit_id,
    stop_id,
    stop_name,
    direction,
    pax_assigned,
    notes,
    created_by_user_id
  ) values (
    p_tenant_id,
    p_service_id,
    p_bus_line_id,
    p_bus_unit_id,
    p_stop_id,
    v_stop.stop_name,
    p_direction,
    p_pax_assigned,
    nullif(trim(coalesce(p_notes, '')), ''),
    p_created_by_user_id
  )
  returning id into v_inserted_id;

  return jsonb_build_object(
    'allocation_id', v_inserted_id,
    'bus_unit_id', p_bus_unit_id,
    'bus_line_id', p_bus_line_id,
    'stop_id', p_stop_id,
    'stop_name', v_stop.stop_name,
    'direction', p_direction,
    'pax_assigned', p_pax_assigned
  );
end;
$$;

create or replace function public.move_bus_allocation(
  p_tenant_id uuid,
  p_allocation_id uuid,
  p_to_bus_unit_id uuid,
  p_pax_moved integer,
  p_reason text,
  p_created_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allocation public.tenant_bus_allocations%rowtype;
  v_source_unit public.tenant_bus_units%rowtype;
  v_target_unit public.tenant_bus_units%rowtype;
  v_target_existing public.tenant_bus_allocations%rowtype;
  v_service public.services%rowtype;
  v_hotel_name text;
  v_target_bus_pax integer;
  v_effective_moved integer;
  v_is_full_move boolean;
  v_target_allocation_id uuid;
begin
  select *
  into v_allocation
  from public.tenant_bus_allocations
  where id = p_allocation_id
    and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Allocazione non trovata.';
  end if;

  if p_pax_moved is null or p_pax_moved <= 0 then
    raise exception 'Numero pax da spostare non valido.';
  end if;

  if p_pax_moved > v_allocation.pax_assigned then
    raise exception 'Non puoi spostare piu pax di quelli assegnati.';
  end if;

  select *
  into v_source_unit
  from public.tenant_bus_units
  where id = v_allocation.bus_unit_id
    and tenant_id = p_tenant_id
  for update;

  select *
  into v_target_unit
  from public.tenant_bus_units
  where id = p_to_bus_unit_id
    and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'Bus destinazione non trovato.';
  end if;

  if v_target_unit.bus_line_id <> v_allocation.bus_line_id then
    raise exception 'Il bus destinazione deve appartenere alla stessa linea.';
  end if;

  if v_target_unit.id = v_source_unit.id then
    raise exception 'Il bus destinazione deve essere diverso dal bus origine.';
  end if;

  if v_target_unit.status in ('closed', 'completed') then
    raise exception 'Bus destinazione chiuso o completato.';
  end if;

  select coalesce(sum(pax_assigned), 0)
  into v_target_bus_pax
  from public.tenant_bus_allocations
  where tenant_id = p_tenant_id
    and bus_unit_id = p_to_bus_unit_id;

  if v_target_bus_pax + p_pax_moved > v_target_unit.capacity then
    raise exception 'Capienza bus destinazione superata.';
  end if;

  v_effective_moved := p_pax_moved;
  v_is_full_move := p_pax_moved = v_allocation.pax_assigned;

  if v_is_full_move then
    update public.tenant_bus_allocations
    set bus_unit_id = p_to_bus_unit_id
    where tenant_id = p_tenant_id
      and id = p_allocation_id;

    v_target_allocation_id := p_allocation_id;
  else
    update public.tenant_bus_allocations
    set pax_assigned = v_allocation.pax_assigned - v_effective_moved
    where tenant_id = p_tenant_id
      and id = p_allocation_id;

    select *
    into v_target_existing
    from public.tenant_bus_allocations
    where tenant_id = p_tenant_id
      and service_id = v_allocation.service_id
      and bus_unit_id = p_to_bus_unit_id
      and bus_line_id = v_allocation.bus_line_id
      and direction = v_allocation.direction
      and stop_name = v_allocation.stop_name
      and (
        (stop_id is null and v_allocation.stop_id is null)
        or stop_id = v_allocation.stop_id
      )
    limit 1
    for update;

    if found then
      update public.tenant_bus_allocations
      set pax_assigned = v_target_existing.pax_assigned + v_effective_moved
      where tenant_id = p_tenant_id
        and id = v_target_existing.id;

      v_target_allocation_id := v_target_existing.id;
    else
      insert into public.tenant_bus_allocations (
        tenant_id,
        service_id,
        bus_line_id,
        bus_unit_id,
        stop_id,
        stop_name,
        direction,
        pax_assigned,
        notes,
        created_by_user_id
      ) values (
        p_tenant_id,
        v_allocation.service_id,
        v_allocation.bus_line_id,
        p_to_bus_unit_id,
        v_allocation.stop_id,
        v_allocation.stop_name,
        v_allocation.direction,
        v_effective_moved,
        v_allocation.notes,
        p_created_by_user_id
      )
      returning id into v_target_allocation_id;
    end if;
  end if;

  select *
  into v_service
  from public.services
  where id = v_allocation.service_id
    and tenant_id = p_tenant_id;

  select name
  into v_hotel_name
  from public.hotels
  where id = v_service.hotel_id
    and tenant_id = p_tenant_id;

  insert into public.tenant_bus_allocation_moves (
    tenant_id,
    service_id,
    from_bus_unit_id,
    to_bus_unit_id,
    stop_name,
    pax_moved,
    reason,
    created_by_user_id,
    customer_name,
    customer_phone,
    hotel_name,
    source_bus_label,
    target_bus_label,
    allocation_snapshot_pax,
    moved_full_allocation
  ) values (
    p_tenant_id,
    v_allocation.service_id,
    v_source_unit.id,
    v_target_unit.id,
    v_allocation.stop_name,
    v_effective_moved,
    nullif(trim(coalesce(p_reason, '')), ''),
    p_created_by_user_id,
    v_service.customer_name,
    coalesce(v_service.phone_e164, v_service.phone),
    v_hotel_name,
    v_source_unit.label,
    v_target_unit.label,
    v_allocation.pax_assigned,
    v_is_full_move
  );

  return jsonb_build_object(
    'allocation_id', p_allocation_id,
    'target_allocation_id', v_target_allocation_id,
    'from_bus_unit_id', v_source_unit.id,
    'to_bus_unit_id', v_target_unit.id,
    'pax_moved', v_effective_moved,
    'moved_full_allocation', v_is_full_move
  );
end;
$$;
