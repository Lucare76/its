-- Aggiunge campo max_vehicle_capacity alle membership degli autisti.
-- NULL = nessun limite (può guidare qualsiasi mezzo).
-- Valore intero = capienza massima assoluta del mezzo guidabile (BLOCCANTE).

alter table public.memberships
  add column if not exists max_vehicle_capacity integer null
  check (max_vehicle_capacity is null or (max_vehicle_capacity > 0 and max_vehicle_capacity <= 120));

comment on column public.memberships.max_vehicle_capacity is
  'Capienza massima del mezzo che l''autista può guidare. NULL = nessun limite. Bloccante in assegnazione.';

-- Popola valori noti per il tenant ITS
do $$
declare
  v_tenant uuid := 'd200b89a-64c7-4f8d-a430-95a33b83047a';

  -- Mappa nome autista → max_vehicle_capacity
  -- (confronto case-insensitive su full_name)
  limits record;
begin
  for limits in
    select name_pattern, cap from (values
      ('andy',          25),
      ('ilaria',        40),
      ('alberto sebon',  8),
      ('jamal',         16),
      ('leo',           16),
      ('angioletto',    25),
      ('biagio ischia',  8)
    ) as t(name_pattern, cap)
  loop
    update public.memberships
    set max_vehicle_capacity = limits.cap
    where tenant_id = v_tenant
      and role = 'driver'
      and lower(full_name) like lower('%' || limits.name_pattern || '%')
      and max_vehicle_capacity is null;
  end loop;
end $$;
