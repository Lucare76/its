-- Fleet ops extensions: licenza mezzo, workflow rifornimenti, manutenzioni avanzate,
-- magazzino ricambi centralizzato e supporto report costi/km.

alter table public.vehicles
  add column if not exists license_number text null;

alter table public.vehicle_fuel
  add column if not exists approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'rejected')),
  add column if not exists approved_at timestamptz null,
  add column if not exists approved_by uuid null,
  add column if not exists fiscal_document_url text null,
  add column if not exists fiscal_document_name text null,
  add column if not exists submitted_via_qr boolean not null default false;

alter table public.vehicle_maintenance
  add column if not exists maintenance_kind text not null default 'ordinary'
    check (maintenance_kind in ('ordinary', 'extraordinary')),
  add column if not exists execution_mode text not null default 'single'
    check (execution_mode in ('single', 'multiple')),
  add column if not exists replaced_parts jsonb not null default '[]'::jsonb;

create table if not exists public.inventory_spare_parts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid null references public.vehicles(id) on delete set null,
  part_name text not null,
  part_code text null,
  supplier text null,
  ordered_from text null,
  ordered_by_name text null,
  order_date date null,
  unit_cost numeric(10,2) null,
  quantity_on_hand integer not null default 0,
  quantity_ordered integer not null default 0,
  status text not null default 'available'
    check (status in ('available', 'ordered', 'out_of_stock')),
  notes text null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_spare_parts enable row level security;

drop policy if exists "tenant_isolation_inventory_spare_parts" on public.inventory_spare_parts;
create policy "tenant_isolation_inventory_spare_parts"
  on public.inventory_spare_parts for all
  using (
    tenant_id in (
      select tenant_id from public.memberships
      where user_id = auth.uid()
    )
  );

create index if not exists idx_inventory_spare_parts_tenant on public.inventory_spare_parts(tenant_id, status);
create index if not exists idx_inventory_spare_parts_vehicle on public.inventory_spare_parts(vehicle_id);
create index if not exists idx_vehicle_fuel_approval_status on public.vehicle_fuel(tenant_id, approval_status, fuel_date desc);
create index if not exists idx_vehicle_maintenance_kind on public.vehicle_maintenance(tenant_id, maintenance_kind, maintenance_date desc);
