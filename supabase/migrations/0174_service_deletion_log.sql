create table if not exists public.service_deletion_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  original_service_id uuid not null,
  customer_name text,
  hotel_name text,
  service_date date,
  pax integer,
  booking_service_kind text,
  status text,
  deleted_by_user_id uuid not null references auth.users(id) on delete set null,
  deleted_by_name text,
  deleted_at timestamptz not null default now(),
  notes text
);

alter table public.service_deletion_log enable row level security;

create policy service_deletion_log_select on public.service_deletion_log
  for select using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'supervisor')
  );

create index if not exists idx_service_deletion_log_tenant
  on public.service_deletion_log(tenant_id, deleted_at desc);
