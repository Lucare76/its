-- Permette di spostare passeggeri tra linee bus diverse (es. Centro → Italia).
-- Prima era bloccato: "Il bus destinazione deve appartenere alla stessa linea."
-- Ora il RPC aggiorna anche bus_line_id quando il bus destinazione è su una linea diversa.

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
  v_service public.services%rowtype;
  v_hotel_name text;
  v_target_bus_pax integer;
  v_effective_moved integer;
  v_is_full_move boolean;
  v_target_allocation_id uuid;
  v_root_allocation_id uuid;
begin
  select * into v_allocation
  from public.tenant_bus_allocations
  where id = p_allocation_id and tenant_id = p_tenant_id
  for update;
  if not found then raise exception 'Allocazione non trovata.'; end if;

  if p_pax_moved is null or p_pax_moved <= 0 then
    raise exception 'Numero pax da spostare non valido.';
  end if;

  if p_pax_moved > v_allocation.pax_assigned then
    raise exception 'Non puoi spostare piu pax di quelli assegnati.';
  end if;

  select * into v_source_unit
  from public.tenant_bus_units
  where id = v_allocation.bus_unit_id and tenant_id = p_tenant_id
  for update;

  select * into v_target_unit
  from public.tenant_bus_units
  where id = p_to_bus_unit_id and tenant_id = p_tenant_id
  for update;
  if not found then raise exception 'Bus destinazione non trovato.'; end if;

  -- Rimossa la restrizione: ora si può spostare su qualsiasi linea
  if v_target_unit.id = v_source_unit.id then
    raise exception 'Il bus destinazione deve essere diverso dal bus origine.';
  end if;

  if v_target_unit.status in ('closed', 'completed') then
    raise exception 'Bus destinazione chiuso o completato.';
  end if;

  select * into v_service
  from public.services
  where id = v_allocation.service_id and tenant_id = p_tenant_id;

  -- Controlla capienza solo per la stessa data del servizio
  select coalesce(sum(a.pax_assigned), 0)
  into v_target_bus_pax
  from public.tenant_bus_allocations a
  join public.services s on s.id = a.service_id
  where a.tenant_id = p_tenant_id
    and a.bus_unit_id = p_to_bus_unit_id
    and s.date = v_service.date;

  if v_target_bus_pax + p_pax_moved > v_target_unit.capacity then
    raise exception 'Capienza bus destinazione superata per questa data.';
  end if;

  v_effective_moved := p_pax_moved;
  v_is_full_move := p_pax_moved = v_allocation.pax_assigned;
  v_root_allocation_id := coalesce(v_allocation.root_allocation_id, v_allocation.id);

  if v_is_full_move then
    update public.tenant_bus_allocations
    set bus_unit_id = p_to_bus_unit_id,
        bus_line_id = v_target_unit.bus_line_id,
        root_allocation_id = v_root_allocation_id
    where tenant_id = p_tenant_id and id = p_allocation_id;

    v_target_allocation_id := p_allocation_id;
  else
    update public.tenant_bus_allocations
    set pax_assigned = pax_assigned - p_pax_moved
    where tenant_id = p_tenant_id and id = p_allocation_id;

    insert into public.tenant_bus_allocations (
      tenant_id, service_id, bus_line_id, bus_unit_id,
      stop_id, stop_name, direction, pax_assigned,
      split_from_allocation_id, root_allocation_id,
      notes, created_by_user_id
    ) values (
      p_tenant_id, v_allocation.service_id, v_target_unit.bus_line_id, p_to_bus_unit_id,
      null, v_allocation.stop_name, v_allocation.direction, p_pax_moved,
      p_allocation_id, v_root_allocation_id,
      v_allocation.notes, p_created_by_user_id
    )
    returning id into v_target_allocation_id;
  end if;

  select h.name into v_hotel_name
  from public.hotels h
  where h.id = v_service.hotel_id and h.tenant_id = p_tenant_id;

  insert into public.tenant_bus_allocation_moves (
    tenant_id, allocation_id, target_allocation_id, root_allocation_id,
    service_id, from_bus_unit_id, to_bus_unit_id,
    stop_name, pax_moved, moved_full_allocation, reason,
    customer_name, customer_phone, hotel_name,
    source_bus_label, target_bus_label,
    created_by_user_id
  ) values (
    p_tenant_id, p_allocation_id, v_target_allocation_id, v_root_allocation_id,
    v_allocation.service_id, v_source_unit.id, p_to_bus_unit_id,
    v_allocation.stop_name, v_effective_moved, v_is_full_move, p_reason,
    coalesce(
      nullif(trim(concat_ws(' ', v_service.customer_first_name, v_service.customer_last_name)), ''),
      nullif(trim(v_service.customer_name), '')
    ),
    v_service.phone,
    v_hotel_name,
    v_source_unit.label,
    v_target_unit.label,
    p_created_by_user_id
  );

  return jsonb_build_object(
    'allocation_id', v_target_allocation_id,
    'from_bus_unit_id', v_source_unit.id,
    'to_bus_unit_id', p_to_bus_unit_id,
    'pax_moved', v_effective_moved,
    'is_full_move', v_is_full_move
  );
end;
$$;
