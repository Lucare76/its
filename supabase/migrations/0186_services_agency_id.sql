-- Aggiunge agency_id (FK) alla tabella services per collegare direttamente
-- i servizi all'anagrafica agenzia, eliminando la dipendenza fragile da billing_party_name.

alter table public.services
  add column if not exists agency_id uuid references public.agencies(id) on delete set null;

-- Trigger: risolve agency_id automaticamente su INSERT / UPDATE di billing_party_name.
-- In questo modo non serve toccare i 19+ route che inseriscono servizi.
create or replace function public.fn_services_resolve_agency_id()
returns trigger language plpgsql as $$
begin
  -- Imposta agency_id solo se billing_party_name è valorizzato e agency_id è null
  if new.billing_party_name is not null and new.agency_id is null then
    select id into new.agency_id
    from   public.agencies
    where  tenant_id = new.tenant_id
      and  lower(trim(name)) = lower(trim(new.billing_party_name))
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_services_resolve_agency_id on public.services;
create trigger trg_services_resolve_agency_id
  before insert or update of billing_party_name
  on public.services
  for each row execute function public.fn_services_resolve_agency_id();

-- Backfill: popola agency_id per i servizi già esistenti che non lo hanno.
update public.services s
set    agency_id = a.id
from   public.agencies a
where  a.tenant_id = s.tenant_id
  and  lower(trim(s.billing_party_name)) = lower(trim(a.name))
  and  s.agency_id is null;

create index if not exists idx_services_agency_id on public.services (agency_id);
create index if not exists idx_services_tenant_agency on public.services (tenant_id, agency_id);
