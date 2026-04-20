-- Vincoli capienza mezzo per hotel con strade strette o limiti logistici.
-- max_capacity = capienza massima assoluta del mezzo ammesso (BLOCCANTE).

create table if not exists public.hotel_vehicle_limits (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  hotel_id    uuid null references public.hotels (id) on delete cascade,
  hotel_name  text not null,
  max_capacity integer not null check (max_capacity > 0 and max_capacity <= 120),
  notes       text null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, hotel_id)
);

create index if not exists hotel_vehicle_limits_tenant_idx on public.hotel_vehicle_limits (tenant_id);
create index if not exists hotel_vehicle_limits_hotel_idx  on public.hotel_vehicle_limits (hotel_id);

alter table public.hotel_vehicle_limits enable row level security;

create policy "hotel_vehicle_limits_tenant_read"
  on public.hotel_vehicle_limits for select
  using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid() and tenant_id = hotel_vehicle_limits.tenant_id
    )
  );

create policy "hotel_vehicle_limits_admin_write"
  on public.hotel_vehicle_limits for all
  using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and tenant_id = hotel_vehicle_limits.tenant_id
        and role in ('admin', 'operator', 'supervisor')
    )
  );

comment on table public.hotel_vehicle_limits is
  'Limiti rigidi di capienza mezzo per hotel con accesso limitato (strade strette, vincoli logistici).';
comment on column public.hotel_vehicle_limits.max_capacity is
  'Capienza massima assoluta del mezzo ammesso per questo hotel. Bloccante in assegnazione manuale e automatica.';
