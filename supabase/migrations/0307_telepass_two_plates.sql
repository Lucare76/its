-- Telepass: un apparato può essere abbinato a DUE targhe contemporaneamente
-- (regola Telepass). Prima l'indice univoco ne consentiva una sola.
--
-- Nuove regole:
--  * lo stesso apparato non può essere attivo due volte sullo stesso mezzo;
--  * al massimo 2 mezzi attivi per apparato (trigger, con lock per evitare
--    che due inserimenti contemporanei superino il limite).

drop index if exists public.vehicle_telepass_devices_one_active;

create unique index if not exists vehicle_telepass_devices_one_active_per_vehicle
  on public.vehicle_telepass_devices(tenant_id, vehicle_id, upper(replace(device_code, ' ', '')))
  where removed_on is null;

create or replace function public.vehicle_telepass_devices_max_two_plates()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_code text := upper(replace(new.device_code, ' ', ''));
  v_active int;
begin
  if new.removed_on is not null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || v_code, 0));
  select count(*) into v_active
    from public.vehicle_telepass_devices
   where tenant_id = new.tenant_id
     and upper(replace(device_code, ' ', '')) = v_code
     and removed_on is null
     and id <> new.id;
  if v_active >= 2 then
    raise exception 'telepass_max_two_plates' using errcode = 'P0001',
      hint = 'Un apparato Telepass può essere abbinato al massimo a due targhe.';
  end if;
  return new;
end;
$$;

drop trigger if exists vehicle_telepass_devices_max_two_plates on public.vehicle_telepass_devices;
create trigger vehicle_telepass_devices_max_two_plates
  before insert or update of device_code, removed_on, tenant_id on public.vehicle_telepass_devices
  for each row execute function public.vehicle_telepass_devices_max_two_plates();

revoke all on function public.vehicle_telepass_devices_max_two_plates() from public, anon, authenticated;
