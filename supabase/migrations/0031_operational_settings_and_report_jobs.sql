create table if not exists public.tenant_operational_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  arrival_summary_hours integer not null default 48 check (arrival_summary_hours between 1 and 168),
  departure_summary_hours integer not null default 48 check (departure_summary_hours between 1 and 168),
  monday_bus_enabled boolean not null default true,
  monday_bus_scope text not null default 'next_sunday_by_agency',
  statement_agencies text[] not null default '{}'::text[],
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_report_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  job_type text not null check (job_type in ('arrivals_48h', 'departures_48h', 'bus_monday', 'statement_agency')),
  target_date date not null,
  owner_name text null,
  status text not null default 'planned' check (status in ('planned', 'previewed', 'exported', 'sent', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  created_by_user_id uuid null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_report_jobs_tenant_created_at on public.ops_report_jobs (tenant_id, created_at desc);
create index if not exists idx_ops_report_jobs_tenant_target_date on public.ops_report_jobs (tenant_id, target_date, job_type);

alter table public.tenant_operational_settings enable row level security;
alter table public.ops_report_jobs enable row level security;

drop policy if exists tenant_operational_settings_tenant_all on public.tenant_operational_settings;
create policy tenant_operational_settings_tenant_all on public.tenant_operational_settings
for all
using (
  tenant_id in (
    select m.tenant_id from public.memberships as m where m.user_id = auth.uid()
  )
)
with check (
  tenant_id in (
    select m.tenant_id from public.memberships as m where m.user_id = auth.uid() and m.role in ('admin', 'operator')
  )
);

drop policy if exists ops_report_jobs_tenant_all on public.ops_report_jobs;
create policy ops_report_jobs_tenant_all on public.ops_report_jobs
for all
using (
  tenant_id in (
    select m.tenant_id from public.memberships as m where m.user_id = auth.uid()
  )
)
with check (
  tenant_id in (
    select m.tenant_id from public.memberships as m where m.user_id = auth.uid() and m.role in ('admin', 'operator')
  )
);
