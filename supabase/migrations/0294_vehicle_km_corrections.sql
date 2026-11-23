-- Office corrections retain the originally submitted end reading and the operator.
create table if not exists public.vehicle_km_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  km_log_id uuid not null references public.vehicle_km_logs(id) on delete cascade,
  old_end_km integer not null,
  new_end_km integer not null,
  corrected_by uuid references auth.users(id) on delete set null,
  corrected_at timestamptz not null default now()
);
create index if not exists vehicle_km_corrections_log_idx on public.vehicle_km_corrections(tenant_id, km_log_id, corrected_at desc);
alter table public.vehicle_km_corrections enable row level security;
create policy vehicle_km_corrections_tenant_read on public.vehicle_km_corrections
  for select to authenticated using (
    exists (select 1 from public.memberships m where m.tenant_id = vehicle_km_corrections.tenant_id
      and m.user_id = auth.uid() and m.role in ('admin', 'operator', 'supervisor'))
  );
-- Writes take place only in the authorized server route using service role.
revoke all on public.vehicle_km_corrections from anon, authenticated;
grant select on public.vehicle_km_corrections to authenticated;

create or replace function public.correct_vehicle_end_km(
  p_tenant_id uuid, p_vehicle_id uuid, p_log_id uuid, p_end_km integer, p_actor_id uuid
) returns integer language plpgsql security definer set search_path = '' as $$
declare prior record;
begin
  perform 1 from public.vehicles where id = p_vehicle_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'Mezzo non trovato'; end if;
  select id, start_km, end_km, start_at, end_at into prior from public.vehicle_km_logs
    where id = p_log_id and vehicle_id = p_vehicle_id for update;
  if not found or prior.end_at is null or prior.end_km is null then raise exception 'Turno chiuso non trovato'; end if;
  if p_end_km < prior.start_km then raise exception 'Km finali inferiori ai km iniziali'; end if;
  if prior.end_km = p_end_km then return prior.end_km; end if;
  update public.vehicle_km_logs set end_km = p_end_km where id = p_log_id;
  insert into public.vehicle_km_corrections(tenant_id, vehicle_id, km_log_id, old_end_km, new_end_km, corrected_by)
    values (p_tenant_id, p_vehicle_id, p_log_id, prior.end_km, p_end_km, p_actor_id);
  if not exists (select 1 from public.vehicle_km_logs where vehicle_id = p_vehicle_id and start_at > prior.start_at) then
    update public.vehicles set km = p_end_km where id = p_vehicle_id and tenant_id = p_tenant_id;
  end if;
  update public.vehicle_anomalies set active = false, resolved_at = now(), resolved_by_user_id = p_actor_id
    where tenant_id = p_tenant_id and vehicle_id = p_vehicle_id and active = true
      and title = 'Km fine turno da correggere' and description like '%' || p_log_id::text || '%';
  return prior.end_km;
end;
$$;
revoke all on function public.correct_vehicle_end_km(uuid, uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.correct_vehicle_end_km(uuid, uuid, uuid, integer, uuid) to service_role;

create or replace function public.flag_vehicle_end_km_for_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  if old.end_at is null and new.end_at is not null
     and (new.end_km < new.start_km or new.end_km - new.start_km > 1000) then
    select tenant_id into v_tenant from public.vehicles where id = new.vehicle_id;
    insert into public.vehicle_anomalies(tenant_id, vehicle_id, severity, title, description)
      values (v_tenant, new.vehicle_id, 'medium', 'Km fine turno da correggere',
        'Turno ' || new.id::text || ': ' || new.start_km || ' km iniziali, ' || new.end_km || ' km finali indicati. Verificare dall''ufficio.');
  end if;
  return new;
end;
$$;
drop trigger if exists flag_vehicle_end_km_for_review on public.vehicle_km_logs;
create trigger flag_vehicle_end_km_for_review after update of end_at on public.vehicle_km_logs
  for each row execute function public.flag_vehicle_end_km_for_review();
