alter table public.assignments
  add column if not exists assignment_source text,
  add column if not exists locked_by_operator boolean default false,
  add column if not exists assigned_by uuid,
  add column if not exists assigned_at timestamptz,
  add column if not exists lock_reason text;

create index if not exists assignments_locked_by_operator
  on public.assignments (tenant_id, locked_by_operator);

create index if not exists assignments_assignment_source
  on public.assignments (tenant_id, assignment_source);
