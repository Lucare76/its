alter table public.service_scan_log
  enable row level security;

drop policy if exists "service_scan_log_service_role_all"
  on public.service_scan_log;
create policy "service_scan_log_service_role_all"
  on public.service_scan_log
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_scan_log_tenant_rw"
  on public.service_scan_log;
create policy "service_scan_log_tenant_rw"
  on public.service_scan_log
  for all
  to authenticated
  using (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = service_scan_log.tenant_id
      and role in ('admin','operator','supervisor','driver')
  ))
  with check (exists (
    select 1
    from public.memberships
    where user_id = auth.uid()
      and tenant_id = service_scan_log.tenant_id
      and role in ('admin','operator','supervisor','driver')
  ));
