create table if not exists public.bus_lot_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  lot_key text not null,
  service_date date not null,
  direction text not null check (direction in ('arrival', 'departure')),
  billing_party_name text null,
  bus_city_origin text null,
  transport_code text null,
  title text null,
  meeting_point text null,
  capacity integer not null check (capacity between 1 and 120),
  low_seat_threshold integer not null default 4 check (low_seat_threshold between 0 and 120),
  minimum_passengers integer null check (minimum_passengers is null or minimum_passengers between 1 and 120),
  waitlist_enabled boolean not null default false,
  waitlist_count integer not null default 0 check (waitlist_count between 0 and 500),
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, lot_key)
);

create index if not exists idx_bus_lot_configs_tenant_date on public.bus_lot_configs (tenant_id, service_date, direction);

alter table public.bus_lot_configs enable row level security;

drop policy if exists bus_lot_configs_tenant_all on public.bus_lot_configs;
create policy bus_lot_configs_tenant_all on public.bus_lot_configs
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
