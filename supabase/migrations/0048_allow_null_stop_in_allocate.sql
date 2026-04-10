-- Permette di allocare un servizio senza fermata specifica (stop_id null, stop_name vuoto)
-- I passeggeri senza fermata appaiono come "da collocare" nella card bus.

create or replace function public.allocate_bus_service(
  p_tenant_id uuid,
  p_service_id uuid,
  p_bus_line_id uuid,
  p_bus_unit_id uuid,
  p_stop_id uuid,       -- può essere null se fermata non trovata
  p_stop_name text,     -- può essere vuoto se fermata non trovata
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
  v_final_stop_name text;
begin
  if p_pax_assigned is null or p_pax_assigned <= 0 or p_pax_assigned > 120 then
    raise exception 'Numero pax non valido.';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Servizio non trovato.'; end if;

  if v_service.direction <> p_direction then
    raise exception 'Direzione servizio e fermata non coerenti.';
  end if;

  select * into v_line
  from public.tenant_bus_lines
  where id = p_bus_line_id and tenant_id = p_tenant_id and active = true;
  if not found then raise exception 'Linea bus non trovata.'; end if;

  select * into v_unit
  from public.tenant_bus_units
  where id = p_bus_unit_id and tenant_id = p_tenant_id
  for update;
  if not found then raise exception 'Bus non trovato.'; end if;

  if v_unit.bus_line_id <> p_bus_line_id then
    raise exception 'Il bus selezionato non appartiene alla linea scelta.';
  end if;

  if v_unit.status in ('closed', 'completed') then
    raise exception 'Bus chiuso o completato: nessuna nuova prenotazione consentita.';
  end if;

  -- Validazione fermata solo se stop_id è fornito
  if p_stop_id is not null then
    select * into v_stop
    from public.tenant_bus_line_stops
    where id = p_stop_id and tenant_id = p_tenant_id and active = true;
    if not found then raise exception 'Fermata non trovata.'; end if;

    if v_stop.bus_line_id <> p_bus_line_id then
      raise exception 'La fermata selezionata non appartiene alla linea scelta.';
    end if;

    if v_stop.direction <> p_direction then
      raise exception 'La fermata selezionata non appartiene alla direzione scelta.';
    end if;

    v_final_stop_name := v_stop.stop_name;
  else
    -- Nessuna fermata trovata: il passeggero sarà visibile come "da collocare"
    v_final_stop_name := coalesce(nullif(trim(p_stop_name), ''), '—');
  end if;

  -- Controlla che il servizio non sia già allocato
  select id into v_existing_allocation_id
  from public.tenant_bus_allocations
  where tenant_id = p_tenant_id and service_id = p_service_id
  limit 1;
  if v_existing_allocation_id is not null then
    raise exception 'Il servizio e'' gia allocato a un bus.';
  end if;

  -- Controlla capienza per la stessa data del servizio
  select coalesce(sum(a.pax_assigned), 0)
  into v_target_bus_pax
  from public.tenant_bus_allocations a
  join public.services s on s.id = a.service_id
  where a.tenant_id = p_tenant_id
    and a.bus_unit_id = p_bus_unit_id
    and s.date = v_service.date;

  if v_target_bus_pax + p_pax_assigned > v_unit.capacity then
    raise exception 'Capienza bus superata per questa data.';
  end if;

  insert into public.tenant_bus_allocations (
    tenant_id, service_id, bus_line_id, bus_unit_id,
    stop_id, stop_name, direction, pax_assigned, notes, created_by_user_id
  ) values (
    p_tenant_id, p_service_id, p_bus_line_id, p_bus_unit_id,
    p_stop_id, v_final_stop_name, p_direction,
    p_pax_assigned, nullif(trim(coalesce(p_notes, '')), ''), p_created_by_user_id
  )
  returning id into v_inserted_id;

  update public.tenant_bus_allocations
  set root_allocation_id = v_inserted_id
  where tenant_id = p_tenant_id and id = v_inserted_id;

  return jsonb_build_object(
    'allocation_id', v_inserted_id,
    'root_allocation_id', v_inserted_id,
    'bus_unit_id', p_bus_unit_id,
    'bus_line_id', p_bus_line_id,
    'stop_id', p_stop_id,
    'stop_name', v_final_stop_name,
    'direction', p_direction,
    'pax_assigned', p_pax_assigned
  );
end;
$$;
