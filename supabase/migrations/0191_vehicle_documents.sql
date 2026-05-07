create table if not exists public.vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.current_tenant_id() references public.tenants (id) on delete cascade,
  vehicle_id uuid not null references public.vehicles (id) on delete cascade,
  title text not null,
  file_path text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid null references auth.users (id) on delete set null,
  notes text null
);

create index if not exists idx_vehicle_documents_vehicle
  on public.vehicle_documents (tenant_id, vehicle_id);

alter table public.vehicle_documents enable row level security;

create policy vehicle_documents_tenant_all on public.vehicle_documents
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
