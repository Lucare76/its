alter table public.vehicle_commitments
  enable row level security;

drop policy if exists "vehicle_commitments_service_role_all"
  on public.vehicle_commitments;
create policy "vehicle_commitments_service_role_all"
  on public.vehicle_commitments
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "vehicle_commitments_tenant_rw"
  on public.vehicle_commitments;
create policy "vehicle_commitments_tenant_rw"
  on public.vehicle_commitments
  for all
  to authenticated
  using (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = vehicle_commitments.tenant_id
      and role in ('admin','operator','supervisor')
  ))
  with check (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = vehicle_commitments.tenant_id
      and role in ('admin','operator','supervisor')
  ));
