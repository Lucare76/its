create table if not exists public.hotel_import_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  source text not null,
  dry_run boolean not null default false,
  limit_applied integer null,
  force_refresh boolean not null default false,
  requested_by_user_id uuid null references auth.users (id) on delete set null,
  status text not null check (status in ('running', 'success', 'error')),
  used_cache boolean not null default false,
  fetched_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  invalid_count integer not null default 0,
  error_message text null,
  payload_json jsonb null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists idx_hotel_import_runs_tenant_source_completed
  on public.hotel_import_runs (tenant_id, source, completed_at desc);

create index if not exists idx_hotel_import_runs_tenant_started
  on public.hotel_import_runs (tenant_id, started_at desc);

alter table public.hotel_import_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'hotel_import_runs'
      and policyname = 'hotel_import_runs_tenant_all'
  ) then
    create policy "hotel_import_runs_tenant_all" on public.hotel_import_runs
    for all using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());
  end if;
end
$$;
