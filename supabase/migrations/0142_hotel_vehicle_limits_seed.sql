-- Seed vincoli hotel → capienza mezzo.
-- Gli hotel con accesso a strade strette hanno limite 14 posti (max assoluto).
-- Alcuni hotel di medie dimensioni hanno limite 40 posti.
-- Gli hotel non elencati non hanno limiti.
--
-- IMPORTANTE: questo seed usa hotel_name come chiave di ricerca.
-- Se l'hotel è già presente nel DB (per tenant ITS), aggiorna anche hotel_id.

do $$
declare
  v_tenant uuid := 'd200b89a-64c7-4f8d-a430-95a33b83047a';

  -- Hotel limite 14 posti (strade strette / accesso ridotto)
  hotels_14 text[] := array[
    'Bristol', 'Regina Palace', 'Tritone', 'Floridiana', 'Parco Aurora',
    'Ambasciatori', 'San Giovanni', 'Excelsior', 'Moresco', 'Rosaleo',
    'Alexander', 'Ulisse', 'Oriente', 'San Francesco', 'Junior Village',
    'Zaro', 'Massimo'
  ];

  -- Hotel limite 40 posti
  hotels_40 text[] := array[
    'Castiglione Village', 'Cristallo', 'Gran Paradiso', 'Approdo'
  ];

  v_name text;
  v_hotel_id uuid;
begin
  -- Inserisci hotel con limite 14
  foreach v_name in array hotels_14 loop
    select id into v_hotel_id
    from public.hotels
    where tenant_id = v_tenant
      and lower(name) like lower('%' || v_name || '%')
    limit 1;

    insert into public.hotel_vehicle_limits (tenant_id, hotel_id, hotel_name, max_capacity)
    values (v_tenant, v_hotel_id, v_name, 14)
    on conflict (tenant_id, hotel_id) do update
      set hotel_name = excluded.hotel_name, max_capacity = excluded.max_capacity;
  end loop;

  -- Inserisci hotel con limite 40
  foreach v_name in array hotels_40 loop
    select id into v_hotel_id
    from public.hotels
    where tenant_id = v_tenant
      and lower(name) like lower('%' || v_name || '%')
    limit 1;

    insert into public.hotel_vehicle_limits (tenant_id, hotel_id, hotel_name, max_capacity)
    values (v_tenant, v_hotel_id, v_name, 40)
    on conflict (tenant_id, hotel_id) do update
      set hotel_name = excluded.hotel_name, max_capacity = excluded.max_capacity;
  end loop;
end $$;
