-- Linea operativa dedicata ai gruppi con bus esclusivo fuori dalle direttrici standard.
do $$
declare
  v_tenant record;
  v_line_id uuid;
  v_existing_units integer;
begin
  for v_tenant in select id from public.tenants loop
    insert into public.tenant_bus_lines (
      tenant_id,
      code,
      name,
      family_code,
      family_name,
      variant_label,
      default_capacity,
      alert_threshold,
      active
    )
    values (
      v_tenant.id,
      'GRUPPI_ESCLUSIVI',
      'Bus esclusivi gruppi',
      'GRUPPI_ESCLUSIVI',
      'Bus esclusivi gruppi',
      'Gruppi fuori linea standard',
      54,
      5,
      true
    )
    on conflict (tenant_id, code) do update set
      name = excluded.name,
      family_code = excluded.family_code,
      family_name = excluded.family_name,
      variant_label = excluded.variant_label,
      default_capacity = excluded.default_capacity,
      alert_threshold = excluded.alert_threshold,
      active = true,
      updated_at = now()
    returning id into v_line_id;

    select count(*)
      into v_existing_units
      from public.tenant_bus_units
      where tenant_id = v_tenant.id
        and bus_line_id = v_line_id;

    if v_existing_units = 0 then
      insert into public.tenant_bus_units (
        tenant_id,
        bus_line_id,
        label,
        capacity,
        low_seat_threshold,
        minimum_passengers,
        status,
        manual_close,
        close_reason,
        sort_order,
        active
      )
      select
        v_tenant.id,
        v_line_id,
        'GRUPPO EX ' || n,
        54,
        5,
        null,
        'open',
        false,
        null,
        n,
        true
      from generate_series(1, 6) as n;
    end if;
  end loop;
end $$;
