alter table public.hotels
  add column if not exists normalized_name text null,
  add column if not exists city text null,
  add column if not exists source text not null default 'manual',
  add column if not exists source_osm_type text null,
  add column if not exists source_osm_id bigint null,
  add column if not exists is_active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

update public.hotels
set
  normalized_name = lower(regexp_replace(coalesce(name, ''), '\s+', ' ', 'g')),
  city = coalesce(nullif(city, ''), 'Ischia'),
  updated_at = coalesce(updated_at, created_at, now())
where normalized_name is null
   or city is null
   or updated_at is null;

create index if not exists idx_hotels_tenant_normalized_name
  on public.hotels (tenant_id, normalized_name);

create unique index if not exists uq_hotels_osm_source
  on public.hotels (tenant_id, source, source_osm_type, source_osm_id)
  where source_osm_id is not null;

create table if not exists public.hotel_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  alias text not null,
  alias_normalized text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_hotel_aliases_tenant_alias
  on public.hotel_aliases (tenant_id, alias_normalized);

create index if not exists idx_hotel_aliases_hotel_id
  on public.hotel_aliases (hotel_id);

alter table public.hotel_aliases enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'hotel_aliases'
      and policyname = 'hotel_aliases_tenant_all'
  ) then
    create policy "hotel_aliases_tenant_all" on public.hotel_aliases
    for all using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());
  end if;
end
$$;
