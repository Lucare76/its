create extension if not exists "pgcrypto";

create type public.app_role as enum ('admin', 'operator', 'driver', 'agency');
create type public.service_direction as enum ('arrival', 'departure');
create type public.service_status as enum ('new', 'assigned', 'partito', 'arrivato', 'completato', 'problema', 'cancelled');
create type public.service_type as enum ('transfer', 'bus_tour');

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role public.app_role not null,
  full_name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

create table if not exists public.hotels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  zone text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  inbound_email_id uuid null,
  is_draft boolean not null default false,
  date date not null,
  time time not null,
  service_type public.service_type not null default 'transfer',
  direction public.service_direction not null,
  vessel text not null,
  pax integer not null check (pax > 0 and pax <= 16),
  hotel_id uuid not null references public.hotels (id) on delete restrict,
  customer_name text not null,
  phone text not null,
  phone_e164 text null,
  notes text not null default '',
  tour_name text null,
  capacity integer null check (capacity is null or capacity > 0),
  meeting_point text null,
  stops jsonb not null default '[]'::jsonb,
  bus_plate text null,
  reminder_status text not null default 'pending' check (reminder_status in ('pending', 'sent', 'delivered', 'read', 'failed')),
  message_id text null,
  sent_at timestamptz null,
  status public.service_status not null default 'new',
  created_at timestamptz not null default now()
);

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  driver_user_id uuid not null references auth.users (id) on delete restrict,
  vehicle_label text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.status_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  status public.service_status not null,
  at timestamptz not null default now(),
  by_user_id uuid not null references auth.users (id) on delete restrict
);

create table if not exists public.whatsapp_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid null references public.services (id) on delete set null,
  to_phone text not null,
  template text null,
  status text not null check (status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  provider_message_id text null,
  happened_at timestamptz not null default now(),
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_whatsapp_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  default_template text not null default 'transfer_reminder',
  template_language text not null default 'it',
  enable_2h_reminder boolean not null default false,
  allow_text_fallback boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  raw_text text not null,
  extracted_text text null,
  parsed_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.services
  add constraint services_inbound_email_id_fkey
  foreign key (inbound_email_id)
  references public.inbound_emails (id)
  on delete set null;

create table if not exists public.export_audits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid null references auth.users (id) on delete set null,
  date_from date not null,
  date_to date not null,
  service_type text not null check (service_type in ('all', 'transfer', 'bus_tour')),
  exported_count integer not null default 0,
  created_at timestamptz not null default now()
);

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select tenant_id
  from public.memberships
  where user_id = auth.uid()
  order by created_at asc
  limit 1
$$;

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
as $$
  select role
  from public.memberships
  where user_id = auth.uid()
    and tenant_id = public.current_tenant_id()
  order by created_at asc
  limit 1
$$;

create or replace function public.is_driver_assigned_service(target_service_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.assignments as a
    join public.services as s on s.id = a.service_id
    where a.service_id = target_service_id
      and a.driver_user_id = auth.uid()
      and s.tenant_id = public.current_tenant_id()
  )
$$;

alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.hotels enable row level security;
alter table public.services enable row level security;
alter table public.assignments enable row level security;
alter table public.status_events enable row level security;
alter table public.whatsapp_events enable row level security;
alter table public.tenant_whatsapp_settings enable row level security;
alter table public.inbound_emails enable row level security;
alter table public.export_audits enable row level security;

create policy "tenants_member_select" on public.tenants
for select using (id in (select tenant_id from public.memberships where user_id = auth.uid()));

create policy "memberships_tenant_select" on public.memberships
for select using (tenant_id = public.current_tenant_id());

create policy "hotels_tenant_all" on public.hotels
for all using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy "services_tenant_select" on public.services
for select using (tenant_id = public.current_tenant_id());

create policy "services_admin_operator_insert" on public.services
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "services_admin_operator_update" on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "services_driver_update_assigned" on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(id)
);

create policy "services_admin_operator_delete" on public.services
for delete using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "assignments_tenant_select" on public.assignments
for select using (tenant_id = public.current_tenant_id());

create policy "assignments_admin_operator_insert" on public.assignments
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "assignments_admin_operator_update" on public.assignments
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "assignments_admin_operator_delete" on public.assignments
for delete using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "status_events_tenant_select" on public.status_events
for select using (tenant_id = public.current_tenant_id());

create policy "status_events_admin_operator_insert" on public.status_events
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "status_events_driver_insert_assigned" on public.status_events
for insert with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and by_user_id = auth.uid()
  and public.is_driver_assigned_service(service_id)
);

create policy "status_events_admin_operator_update" on public.status_events
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "status_events_admin_operator_delete" on public.status_events
for delete using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy "whatsapp_events_tenant_all" on public.whatsapp_events
for all using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy "tenant_whatsapp_settings_tenant_all" on public.tenant_whatsapp_settings
for all using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy "inbound_emails_tenant_all" on public.inbound_emails
for all using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy "export_audits_tenant_all" on public.export_audits
for all using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());
