-- Migration: ITS Health / Job Registry Foundation.
--
-- system_job_runs is intentionally separate from ops_report_jobs:
-- - ops_report_jobs = operational queue of reports to execute/send
-- - system_job_runs = historical evidence of what actually happened during a run

create table if not exists public.system_job_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null references public.tenants (id) on delete cascade,
  job_key text not null,
  job_name text not null,
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running' check (status in ('running', 'success', 'warning', 'failed')),
  processed_count integer not null default 0 check (processed_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_system_job_runs_job_key_started_at
  on public.system_job_runs (job_key, started_at desc);

create index if not exists idx_system_job_runs_started_at
  on public.system_job_runs (started_at desc);

create index if not exists idx_system_job_runs_status_started_at
  on public.system_job_runs (status, started_at desc);

create index if not exists idx_system_job_runs_tenant_job_started
  on public.system_job_runs (tenant_id, job_key, started_at desc);

alter table public.system_job_runs enable row level security;

drop policy if exists system_job_runs_select_tenant_admin_supervisor on public.system_job_runs;
create policy system_job_runs_select_tenant_admin_supervisor on public.system_job_runs
for select using (
  tenant_id is null
  or tenant_id in (
    select m.tenant_id
    from public.memberships as m
    where m.user_id = auth.uid()
      and m.suspended is not true
      and m.role in ('admin', 'supervisor')
  )
);

-- Writes are performed by server-side service-role cron/API code only.
-- No insert/update/delete policy is intentionally exposed to browser clients.
