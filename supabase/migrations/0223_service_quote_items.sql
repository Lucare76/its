-- Multi-service rows for customer service quotes.

create table if not exists public.service_quote_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  quote_id uuid not null references public.service_quotes (id) on delete cascade,
  sort_order integer not null default 0,
  item_type text not null default 'service'
    check (item_type in ('service', 'free_text')),

  title text,
  description text,

  service_type text,
  direction text
    check (direction is null or direction in ('arrival','departure','round_trip')),

  arrival_date date,
  arrival_time time,
  arrival_flight_train text,
  departure_date date,
  departure_time time,
  departure_flight_train text,

  hotel_name text,
  hotel_address text,
  pax integer not null default 1 check (pax >= 0 and pax <= 200),
  quantity integer not null default 1 check (quantity >= 1 and quantity <= 999),
  luggage_notes text,
  special_requests text,

  unit_price_cents integer not null default 0 check (unit_price_cents >= 0),
  total_price_cents integer not null default 0 check (total_price_cents >= 0),
  price_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_service_quote_items_quote
  on public.service_quote_items (quote_id, sort_order);

create index if not exists idx_service_quote_items_tenant_quote
  on public.service_quote_items (tenant_id, quote_id);

alter table public.service_quote_items enable row level security;

drop policy if exists service_quote_items_tenant_all on public.service_quote_items;
create policy service_quote_items_tenant_all
  on public.service_quote_items
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

insert into public.service_quote_items (
  tenant_id, quote_id, sort_order, item_type, title, service_type, direction,
  arrival_date, arrival_time, arrival_flight_train,
  departure_date, departure_time, departure_flight_train,
  hotel_name, hotel_address, pax, quantity, luggage_notes, special_requests,
  unit_price_cents, total_price_cents, price_notes, created_at, updated_at
)
select
  q.tenant_id,
  q.id,
  0,
  'service',
  null,
  q.service_type,
  q.direction,
  q.arrival_date,
  q.arrival_time,
  q.arrival_flight_train,
  q.departure_date,
  q.departure_time,
  q.departure_flight_train,
  q.hotel_name,
  q.hotel_address,
  q.pax,
  1,
  q.luggage_notes,
  q.special_requests,
  q.price_cents,
  q.price_cents * greatest(q.pax, 1),
  q.price_notes,
  q.created_at,
  q.updated_at
from public.service_quotes q
where not exists (
  select 1
  from public.service_quote_items i
  where i.quote_id = q.id
);
