do $$
declare
  target_tenant uuid := 'd200b89a-64c7-4f8d-a430-95a33b83047a'::uuid;
  has_meeting_point boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'services'
      and column_name = 'meeting_point'
  )
  into has_meeting_point;

  -- Prima di azzerare il catalogo, preserviamo il nome struttura sui servizi
  -- cosi le viste operative continuano a mostrare una destinazione leggibile.
  if has_meeting_point then
    update public.services s
    set meeting_point = coalesce(nullif(trim(s.meeting_point), ''), h.name)
    from public.hotels h
    where s.tenant_id = target_tenant
      and h.tenant_id = target_tenant
      and s.hotel_id = h.id;
  end if;

  delete from public.hotel_aliases
  where tenant_id = target_tenant;

  update public.services
  set hotel_id = null
  where tenant_id = target_tenant
    and hotel_id in (
      select id
      from public.hotels
      where tenant_id = target_tenant
    );

  delete from public.hotels
  where tenant_id = target_tenant;
end $$;
