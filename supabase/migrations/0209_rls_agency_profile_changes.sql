alter table public.agency_profile_changes
  enable row level security;

drop policy if exists "agency_profile_changes_service_role_all"
  on public.agency_profile_changes;
create policy "agency_profile_changes_service_role_all"
  on public.agency_profile_changes
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "agency_profile_changes_tenant_rw"
  on public.agency_profile_changes;
create policy "agency_profile_changes_tenant_rw"
  on public.agency_profile_changes
  for all
  to authenticated
  using (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = agency_profile_changes.tenant_id
      and role in ('admin','operator','supervisor','agency')
  ))
  with check (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = agency_profile_changes.tenant_id
      and role in ('admin','operator','supervisor','agency')
  ));
