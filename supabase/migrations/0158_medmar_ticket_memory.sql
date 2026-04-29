create table if not exists public.medmar_ticket_memory (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  route_code text not null check (route_code in (
    'pozzuoli_ischia',
    'pozzuoli_casamicciola',
    'napoli_ischia',
    'napoli_casamicciola',
    'ischia_pozzuoli',
    'casamicciola_pozzuoli',
    'ischia_napoli',
    'casamicciola_napoli'
  )),
  travel_date date not null,
  departure_time time,
  issue_date date,
  ticket_number text,
  booking_code text,
  voucher_label text,
  tariff_label text,
  price_cents integer,
  quantity integer not null default 1 check (quantity > 0),
  status text not null default 'available' check (status in ('available', 'matched', 'used', 'expired')),
  matched_service_id uuid references public.services(id) on delete set null,
  photo_path text,
  photo_url text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_medmar_ticket_memory_tenant_date
  on public.medmar_ticket_memory(tenant_id, travel_date desc);

create index if not exists idx_medmar_ticket_memory_tenant_status
  on public.medmar_ticket_memory(tenant_id, status, travel_date desc);

alter table public.medmar_ticket_memory enable row level security;

create policy medmar_ticket_memory_select on public.medmar_ticket_memory
  for select using (tenant_id = public.current_tenant_id());

create policy medmar_ticket_memory_insert on public.medmar_ticket_memory
  for insert with check (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );

create policy medmar_ticket_memory_update on public.medmar_ticket_memory
  for update using (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
  );
