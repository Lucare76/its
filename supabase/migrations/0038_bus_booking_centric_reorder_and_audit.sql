alter table public.tenant_bus_allocations
  add column if not exists root_allocation_id uuid null references public.tenant_bus_allocations (id) on delete set null,
  add column if not exists split_from_allocation_id uuid null references public.tenant_bus_allocations (id) on delete set null;

update public.tenant_bus_allocations
set root_allocation_id = id
where root_allocation_id is null;

create index if not exists idx_tenant_bus_allocations_root_allocation
  on public.tenant_bus_allocations (tenant_id, root_allocation_id);

create index if not exists idx_tenant_bus_allocations_split_from
  on public.tenant_bus_allocations (tenant_id, split_from_allocation_id);

alter table public.tenant_bus_line_stops
  add column if not exists order_index integer null;

update public.tenant_bus_line_stops
set order_index = stop_order
where order_index is null;

alter table public.tenant_bus_line_stops
  alter column order_index set not null;

alter table public.tenant_bus_line_stops
  drop constraint if exists tenant_bus_line_stops_order_index_check;

alter table public.tenant_bus_line_stops
  add constraint tenant_bus_line_stops_order_index_check
  check (order_index >= 1) not valid;

alter table public.tenant_bus_line_stops
  validate constraint tenant_bus_line_stops_order_index_check;

alter table public.tenant_bus_allocation_moves
  add column if not exists allocation_id uuid null references public.tenant_bus_allocations (id) on delete set null,
  add column if not exists target_allocation_id uuid null references public.tenant_bus_allocations (id) on delete set null,
  add column if not exists root_allocation_id uuid null references public.tenant_bus_allocations (id) on delete set null;

drop view if exists public.ops_bus_allocation_details;

create view public.ops_bus_allocation_details as
select
  a.id as allocation_id,
  coalesce(a.root_allocation_id, a.id) as root_allocation_id,
  a.split_from_allocation_id,
  a.service_id,
  a.bus_line_id,
  l.code as line_code,
  l.name as line_name,
  l.family_code,
  l.family_name,
  a.bus_unit_id,
  u.label as bus_label,
  a.stop_id,
  a.stop_name,
  s2.city as stop_city,
  a.direction,
  a.pax_assigned,
  s.date as service_date,
  s.time as service_time,
  coalesce(
    nullif(trim(concat_ws(' ', s.customer_first_name, s.customer_last_name)), ''),
    nullif(trim(s.customer_name), ''),
    'Cliente N/D'
  ) as customer_name,
  s.phone as customer_phone,
  h.name as hotel_name,
  a.notes,
  a.created_at
from public.tenant_bus_allocations a
join public.tenant_bus_lines l on l.id = a.bus_line_id
join public.tenant_bus_units u on u.id = a.bus_unit_id
left join public.tenant_bus_line_stops s2 on s2.id = a.stop_id
join public.services s on s.id = a.service_id
left join public.hotels h on h.id = s.hotel_id
where l.tenant_id = a.tenant_id
  and u.tenant_id = a.tenant_id
  and s.tenant_id = a.tenant_id;

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

  update public.tenant_bus_allocations
  set root_allocation_id = v_inserted_id
  where tenant_id = p_tenant_id
    and id = v_inserted_id;

  return jsonb_build_object(
    'allocation_id', v_inserted_id,
    'root_allocation_id', v_inserted_id,
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
  v_service public.services%rowtype;
  v_hotel_name text;
  v_target_bus_pax integer;
  v_effective_moved integer;
  v_is_full_move boolean;
  v_target_allocation_id uuid;
  v_root_allocation_id uuid;
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
  v_root_allocation_id := coalesce(v_allocation.root_allocation_id, v_allocation.id);

  if v_is_full_move then
    update public.tenant_bus_allocations
    set
      bus_unit_id = p_to_bus_unit_id,
      root_allocation_id = v_root_allocation_id
    where tenant_id = p_tenant_id
      and id = p_allocation_id;

    v_target_allocation_id := p_allocation_id;
  else
    update public.tenant_bus_allocations
    set pax_assigned = v_allocation.pax_assigned - v_effective_moved
    where tenant_id = p_tenant_id
      and id = p_allocation_id;

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
      created_by_user_id,
      root_allocation_id,
      split_from_allocation_id
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
      p_created_by_user_id,
      v_root_allocation_id,
      v_allocation.id
    )
    returning id into v_target_allocation_id;
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
    moved_full_allocation,
    allocation_id,
    target_allocation_id,
    root_allocation_id
  ) values (
    p_tenant_id,
    v_allocation.service_id,
    v_source_unit.id,
    v_target_unit.id,
    v_allocation.stop_name,
    v_effective_moved,
    nullif(trim(coalesce(p_reason, '')), ''),
    p_created_by_user_id,
    coalesce(
      nullif(trim(concat_ws(' ', v_service.customer_first_name, v_service.customer_last_name)), ''),
      v_service.customer_name
    ),
    v_service.phone,
    v_hotel_name,
    v_source_unit.label,
    v_target_unit.label,
    v_allocation.pax_assigned,
    v_is_full_move,
    v_allocation.id,
    v_target_allocation_id,
    v_root_allocation_id
  );

  return jsonb_build_object(
    'allocation_id', p_allocation_id,
    'target_allocation_id', v_target_allocation_id,
    'root_allocation_id', v_root_allocation_id,
    'from_bus_unit_id', v_source_unit.id,
    'to_bus_unit_id', v_target_unit.id,
    'pax_moved', v_effective_moved,
    'moved_full_allocation', v_is_full_move
  );
end;
$$;

create or replace function public.reorder_bus_line_stops(
  p_tenant_id uuid,
  p_bus_line_id uuid,
  p_direction public.service_direction,
  p_stop_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stop_id uuid;
  v_index integer;
  v_count integer;
begin
  if p_stop_ids is null or coalesce(array_length(p_stop_ids, 1), 0) = 0 then
    raise exception 'Ordine fermate non valido.';
  end if;

  select count(*)
  into v_count
  from public.tenant_bus_line_stops
  where tenant_id = p_tenant_id
    and bus_line_id = p_bus_line_id
    and direction = p_direction
    and id = any(p_stop_ids);

  if v_count <> array_length(p_stop_ids, 1) then
    raise exception 'Una o piu fermate non appartengono alla linea/direzione selezionata.';
  end if;

  v_index := 1;
  foreach v_stop_id in array p_stop_ids loop
    update public.tenant_bus_line_stops
    set
      stop_order = v_index,
      order_index = v_index,
      updated_at = now()
    where tenant_id = p_tenant_id
      and bus_line_id = p_bus_line_id
      and direction = p_direction
      and id = v_stop_id;

    v_index := v_index + 1;
  end loop;

  return jsonb_build_object(
    'bus_line_id', p_bus_line_id,
    'direction', p_direction,
    'reordered', array_length(p_stop_ids, 1)
  );
end;
$$;
