do $$
begin
  if not exists (
    select 1
    from pg_type
    where typname = 'booking_qr_direction'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.booking_qr_direction as enum ('outbound', 'return');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typname = 'booking_qr_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.booking_qr_status as enum ('active', 'used', 'cancelled');
  end if;
end $$;

create table if not exists public.booking_qr_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid not null references public.services(id) on delete cascade,
  direction public.booking_qr_direction not null,
  service_date date not null,
  qr_token text not null,
  qr_payload text not null,
  qr_image_url text not null,
  qr_file_path text null,
  status public.booking_qr_status not null default 'active',
  used_at timestamptz null,
  used_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_qr_codes_booking_direction_unique unique (booking_id, direction),
  constraint booking_qr_codes_token_unique unique (qr_token)
);

create index if not exists idx_booking_qr_codes_booking
  on public.booking_qr_codes (booking_id, direction);

create index if not exists idx_booking_qr_codes_tenant
  on public.booking_qr_codes (tenant_id, service_date desc);

create index if not exists idx_booking_qr_codes_status
  on public.booking_qr_codes (tenant_id, status, service_date desc);

create or replace function public.set_booking_qr_codes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_booking_qr_codes_updated_at on public.booking_qr_codes;
create trigger trg_booking_qr_codes_updated_at
  before update on public.booking_qr_codes
  for each row
  execute function public.set_booking_qr_codes_updated_at();

alter table public.booking_qr_codes enable row level security;

drop policy if exists booking_qr_codes_select_tenant_member on public.booking_qr_codes;
create policy booking_qr_codes_select_tenant_member
  on public.booking_qr_codes
  for select
  using (
    tenant_id in (
      select tenant_id
      from public.memberships
      where user_id = auth.uid()
    )
  );

drop policy if exists booking_qr_codes_update_tenant_member on public.booking_qr_codes;
create policy booking_qr_codes_update_tenant_member
  on public.booking_qr_codes
  for update
  using (
    tenant_id in (
      select tenant_id
      from public.memberships
      where user_id = auth.uid()
    )
  )
  with check (
    tenant_id in (
      select tenant_id
      from public.memberships
      where user_id = auth.uid()
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bus-qr-codes',
  'bus-qr-codes',
  true,
  5242880,
  array['image/png']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists public_read_bus_qr_codes on storage.objects;
create policy public_read_bus_qr_codes
  on storage.objects
  for select
  using (bucket_id = 'bus-qr-codes');
