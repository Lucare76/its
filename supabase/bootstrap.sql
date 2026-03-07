-- Ischia Transfer Beta - Bootstrap schema for Supabase SQL Editor
-- Run this file first in Supabase: SQL Editor -> New query -> paste all -> Run

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'operator', 'driver', 'agency');
  end if;

  if not exists (select 1 from pg_type where typname = 'service_direction') then
    create type public.service_direction as enum ('arrival', 'departure');
  end if;

  if not exists (select 1 from pg_type where typname = 'service_status') then
    create type public.service_status as enum ('new', 'assigned', 'partito', 'arrivato', 'completato', 'problema', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'service_type') then
    create type public.service_type as enum ('transfer', 'bus_tour');
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_type where typname = 'service_status') then
    begin
      alter type public.service_status add value if not exists 'problema';
    exception
      when duplicate_object then null;
    end;
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_type where typname = 'service_type') then
    begin
      alter type public.service_type add value if not exists 'bus_tour';
    exception
      when duplicate_object then null;
    end;
  end if;
end
$$;

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
  created_by_user_id uuid null references auth.users (id) on delete set null,
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

alter table public.services add column if not exists service_type public.service_type not null default 'transfer';
alter table public.services add column if not exists inbound_email_id uuid null;
alter table public.services add column if not exists is_draft boolean not null default false;
alter table public.services add column if not exists tour_name text null;
alter table public.services add column if not exists capacity integer null;
alter table public.services add column if not exists meeting_point text null;
alter table public.services add column if not exists stops jsonb not null default '[]'::jsonb;
alter table public.services add column if not exists bus_plate text null;
alter table public.services add column if not exists excursion_name text null;
alter table public.services add column if not exists bus_capacity integer null;
alter table public.services add column if not exists guide_name text null;
alter table public.services add column if not exists created_by_user_id uuid null references auth.users (id) on delete set null;
alter table public.services alter column created_by_user_id set default auth.uid();
alter table public.services add column if not exists phone_e164 text null;
alter table public.services add column if not exists reminder_status text not null default 'pending';
alter table public.services add column if not exists message_id text null;
alter table public.services add column if not exists sent_at timestamptz null;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_reminder_status_check'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_reminder_status_check
      check (reminder_status in ('pending', 'sent', 'delivered', 'read', 'failed'));
  end if;
end
$$;

update public.services
set service_type = 'transfer'
where service_type::text in ('excursion', 'shuttle', 'custom');

update public.services
set
  tour_name = coalesce(tour_name, excursion_name),
  capacity = coalesce(capacity, bus_capacity),
  bus_plate = coalesce(bus_plate, null)
where service_type = 'bus_tour'::public.service_type or excursion_name is not null;

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  driver_user_id uuid null references auth.users (id) on delete set null,
  vehicle_label text not null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'assignments_service_id_key'
      and conrelid = 'public.assignments'::regclass
  ) then
    alter table public.assignments
      add constraint assignments_service_id_key unique (service_id);
  end if;
end
$$;

create table if not exists public.status_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  status public.service_status not null,
  at timestamptz not null default now(),
  by_user_id uuid null references auth.users (id) on delete set null
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

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  label text not null,
  plate text null,
  capacity integer null check (capacity is null or capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_geo_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  zones text[] not null default '{}',
  ports text[] not null default '{}',
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

alter table public.inbound_emails
  add column if not exists extracted_text text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_inbound_email_id_fkey'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_inbound_email_id_fkey
      foreign key (inbound_email_id)
      references public.inbound_emails (id)
      on delete set null;
  end if;
end
$$;

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

update public.export_audits
set service_type = 'transfer'
where service_type not in ('all', 'transfer', 'bus_tour');

alter table public.export_audits
  drop constraint if exists export_audits_service_type_check;
alter table public.export_audits
  add constraint export_audits_service_type_check
  check (service_type in ('all', 'transfer', 'bus_tour'));

create index if not exists idx_memberships_tenant_id on public.memberships (tenant_id);
create index if not exists idx_hotels_tenant_id on public.hotels (tenant_id);
create index if not exists idx_services_tenant_id on public.services (tenant_id);
create index if not exists idx_services_inbound_email_id on public.services (inbound_email_id);
create index if not exists idx_services_tenant_date on public.services (tenant_id, date);
create index if not exists idx_services_tenant_status on public.services (tenant_id, status);
create index if not exists idx_services_tenant_reminder_status on public.services (tenant_id, reminder_status);
create index if not exists idx_services_tenant_sent_at on public.services (tenant_id, sent_at desc);
create index if not exists idx_services_tenant_created_by on public.services (tenant_id, created_by_user_id);
create index if not exists idx_services_message_id on public.services (message_id);
create index if not exists idx_assignments_tenant_id on public.assignments (tenant_id);
create index if not exists idx_assignments_service_id on public.assignments (service_id);
create index if not exists idx_status_events_tenant_id on public.status_events (tenant_id);
create index if not exists idx_status_events_service_id on public.status_events (service_id);
create index if not exists idx_status_events_tenant_status on public.status_events (tenant_id, status);
create index if not exists idx_whatsapp_events_tenant_happened_at on public.whatsapp_events (tenant_id, happened_at desc);
create index if not exists idx_whatsapp_events_service_id on public.whatsapp_events (service_id);
create index if not exists idx_whatsapp_events_provider_message_id on public.whatsapp_events (provider_message_id);
create index if not exists idx_tenant_whatsapp_settings_updated_at on public.tenant_whatsapp_settings (updated_at desc);
create index if not exists idx_vehicles_tenant_id on public.vehicles (tenant_id);
create index if not exists idx_tenant_geo_settings_updated_at on public.tenant_geo_settings (updated_at desc);
create index if not exists idx_inbound_emails_tenant_created_at on public.inbound_emails (tenant_id, created_at desc);
create index if not exists idx_export_audits_tenant_created_at on public.export_audits (tenant_id, created_at desc);

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
    where a.service_id = target_service_id
      and a.tenant_id = public.current_tenant_id()
      and a.driver_user_id = auth.uid()
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
alter table public.vehicles enable row level security;
alter table public.tenant_geo_settings enable row level security;
alter table public.inbound_emails enable row level security;
alter table public.export_audits enable row level security;

drop policy if exists tenants_member_select on public.tenants;
drop policy if exists memberships_tenant_select on public.memberships;
drop policy if exists memberships_self_or_tenant_select on public.memberships;
drop policy if exists memberships_tenant_all on public.memberships;
drop policy if exists memberships_admin_operator_insert on public.memberships;
drop policy if exists memberships_admin_operator_update on public.memberships;
drop policy if exists memberships_admin_operator_delete on public.memberships;
drop policy if exists hotels_tenant_all on public.hotels;
drop policy if exists services_tenant_all on public.services;
drop policy if exists services_tenant_select on public.services;
drop policy if exists services_admin_operator_insert on public.services;
drop policy if exists services_admin_operator_update on public.services;
drop policy if exists services_driver_update_assigned on public.services;
drop policy if exists services_admin_operator_delete on public.services;
drop policy if exists assignments_tenant_all on public.assignments;
drop policy if exists assignments_tenant_select on public.assignments;
drop policy if exists assignments_admin_operator_insert on public.assignments;
drop policy if exists assignments_admin_operator_update on public.assignments;
drop policy if exists assignments_admin_operator_delete on public.assignments;
drop policy if exists status_events_tenant_all on public.status_events;
drop policy if exists status_events_tenant_select on public.status_events;
drop policy if exists status_events_admin_operator_insert on public.status_events;
drop policy if exists status_events_driver_insert_assigned on public.status_events;
drop policy if exists status_events_admin_operator_update on public.status_events;
drop policy if exists status_events_admin_operator_delete on public.status_events;
drop policy if exists whatsapp_events_tenant_all on public.whatsapp_events;
drop policy if exists tenant_whatsapp_settings_tenant_all on public.tenant_whatsapp_settings;
drop policy if exists vehicles_tenant_select on public.vehicles;
drop policy if exists vehicles_admin_operator_insert on public.vehicles;
drop policy if exists vehicles_admin_operator_update on public.vehicles;
drop policy if exists vehicles_admin_operator_delete on public.vehicles;
drop policy if exists tenant_geo_settings_tenant_select on public.tenant_geo_settings;
drop policy if exists tenant_geo_settings_admin_operator_insert on public.tenant_geo_settings;
drop policy if exists tenant_geo_settings_admin_operator_update on public.tenant_geo_settings;
drop policy if exists tenant_geo_settings_admin_operator_delete on public.tenant_geo_settings;
drop policy if exists inbound_emails_tenant_all on public.inbound_emails;
drop policy if exists export_audits_tenant_all on public.export_audits;

create policy tenants_member_select on public.tenants
for select
using (
  id in (
    select m.tenant_id
    from public.memberships as m
    where m.user_id = auth.uid()
  )
);

create policy memberships_self_or_tenant_select on public.memberships
for select
using (user_id = auth.uid() or tenant_id = public.current_tenant_id());

create policy memberships_admin_operator_insert on public.memberships
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_admin_operator_update on public.memberships
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_admin_operator_delete on public.memberships
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy hotels_tenant_all on public.hotels
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy services_tenant_select on public.services
for select
using (tenant_id = public.current_tenant_id());

create policy services_admin_operator_insert on public.services
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_admin_operator_update on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_driver_update_assigned on public.services
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

create policy services_admin_operator_delete on public.services
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_tenant_select on public.assignments
for select
using (tenant_id = public.current_tenant_id());

create policy assignments_admin_operator_insert on public.assignments
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_admin_operator_update on public.assignments
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_admin_operator_delete on public.assignments
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_tenant_select on public.status_events
for select
using (tenant_id = public.current_tenant_id());

create policy status_events_admin_operator_insert on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_driver_insert_assigned on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and by_user_id = auth.uid()
  and public.is_driver_assigned_service(service_id)
);

create policy status_events_admin_operator_update on public.status_events
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_admin_operator_delete on public.status_events
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy whatsapp_events_tenant_all on public.whatsapp_events
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy tenant_whatsapp_settings_tenant_all on public.tenant_whatsapp_settings
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy vehicles_tenant_select on public.vehicles
for select
using (tenant_id = public.current_tenant_id());

create policy vehicles_admin_operator_insert on public.vehicles
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy vehicles_admin_operator_update on public.vehicles
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy vehicles_admin_operator_delete on public.vehicles
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_geo_settings_tenant_select on public.tenant_geo_settings
for select
using (tenant_id = public.current_tenant_id());

create policy tenant_geo_settings_admin_operator_insert on public.tenant_geo_settings
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_geo_settings_admin_operator_update on public.tenant_geo_settings
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy tenant_geo_settings_admin_operator_delete on public.tenant_geo_settings
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_tenant_all on public.inbound_emails
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

create policy export_audits_tenant_all on public.export_audits
for all
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

-- Final RLS hardening override (multi-tenant + role scoped visibility)
drop policy if exists services_tenant_select on public.services;
drop policy if exists services_admin_operator_insert on public.services;
drop policy if exists services_admin_operator_update on public.services;
drop policy if exists services_driver_update_assigned on public.services;
drop policy if exists services_admin_operator_delete on public.services;
drop policy if exists services_select_admin_operator_tenant on public.services;
drop policy if exists services_select_driver_assigned on public.services;
drop policy if exists services_select_agency_owned on public.services;
drop policy if exists services_insert_admin_operator on public.services;
drop policy if exists services_insert_agency_owned on public.services;
drop policy if exists services_update_admin_operator on public.services;
drop policy if exists services_update_driver_assigned on public.services;
drop policy if exists services_update_agency_owned on public.services;
drop policy if exists services_delete_admin_operator on public.services;

create policy services_select_admin_operator_tenant on public.services
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_select_driver_assigned on public.services
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(id)
);

create policy services_select_agency_owned on public.services
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
);

create policy services_insert_admin_operator on public.services
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_insert_agency_owned on public.services
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
);

create policy services_update_admin_operator on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy services_update_driver_assigned on public.services
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

create policy services_update_agency_owned on public.services
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and created_by_user_id = auth.uid()
);

create policy services_delete_admin_operator on public.services
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists assignments_tenant_select on public.assignments;
drop policy if exists assignments_admin_operator_insert on public.assignments;
drop policy if exists assignments_admin_operator_update on public.assignments;
drop policy if exists assignments_admin_operator_delete on public.assignments;
drop policy if exists assignments_select_admin_operator_tenant on public.assignments;
drop policy if exists assignments_select_driver_own on public.assignments;
drop policy if exists assignments_select_agency_owned_service on public.assignments;
drop policy if exists assignments_insert_admin_operator on public.assignments;
drop policy if exists assignments_update_admin_operator on public.assignments;
drop policy if exists assignments_delete_admin_operator on public.assignments;

create policy assignments_select_admin_operator_tenant on public.assignments
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_select_driver_own on public.assignments
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and driver_user_id = auth.uid()
);

create policy assignments_select_agency_owned_service on public.assignments
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and exists (
    select 1
    from public.services as s
    where s.id = service_id
      and s.tenant_id = public.current_tenant_id()
      and s.created_by_user_id = auth.uid()
  )
);

create policy assignments_insert_admin_operator on public.assignments
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_update_admin_operator on public.assignments
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy assignments_delete_admin_operator on public.assignments
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists memberships_self_or_tenant_select on public.memberships;
drop policy if exists memberships_admin_operator_insert on public.memberships;
drop policy if exists memberships_admin_operator_update on public.memberships;
drop policy if exists memberships_admin_operator_delete on public.memberships;
drop policy if exists memberships_select_self_or_admin_operator on public.memberships;
drop policy if exists memberships_insert_admin_operator on public.memberships;
drop policy if exists memberships_update_admin_operator on public.memberships;
drop policy if exists memberships_delete_admin_operator on public.memberships;

create policy memberships_select_self_or_admin_operator on public.memberships
for select
using (
  user_id = auth.uid()
  or (
    tenant_id = public.current_tenant_id()
    and public.current_user_role() in ('admin', 'operator')
  )
);

create policy memberships_insert_admin_operator on public.memberships
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_update_admin_operator on public.memberships
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy memberships_delete_admin_operator on public.memberships
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists hotels_tenant_all on public.hotels;
drop policy if exists hotels_select_tenant_member on public.hotels;
drop policy if exists hotels_insert_admin_operator on public.hotels;
drop policy if exists hotels_update_admin_operator on public.hotels;
drop policy if exists hotels_delete_admin_operator on public.hotels;

create policy hotels_select_tenant_member on public.hotels
for select
using (tenant_id = public.current_tenant_id());

create policy hotels_insert_admin_operator on public.hotels
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy hotels_update_admin_operator on public.hotels
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy hotels_delete_admin_operator on public.hotels
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists inbound_emails_tenant_all on public.inbound_emails;
drop policy if exists inbound_emails_select_admin_operator on public.inbound_emails;
drop policy if exists inbound_emails_insert_admin_operator on public.inbound_emails;
drop policy if exists inbound_emails_update_admin_operator on public.inbound_emails;
drop policy if exists inbound_emails_delete_admin_operator on public.inbound_emails;

create policy inbound_emails_select_admin_operator on public.inbound_emails
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_insert_admin_operator on public.inbound_emails
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_update_admin_operator on public.inbound_emails
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy inbound_emails_delete_admin_operator on public.inbound_emails
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

drop policy if exists status_events_tenant_select on public.status_events;
drop policy if exists status_events_admin_operator_insert on public.status_events;
drop policy if exists status_events_driver_insert_assigned on public.status_events;
drop policy if exists status_events_admin_operator_update on public.status_events;
drop policy if exists status_events_admin_operator_delete on public.status_events;
drop policy if exists status_events_select_admin_operator_tenant on public.status_events;
drop policy if exists status_events_select_driver_assigned on public.status_events;
drop policy if exists status_events_select_agency_owned_service on public.status_events;
drop policy if exists status_events_insert_admin_operator on public.status_events;
drop policy if exists status_events_insert_driver_assigned on public.status_events;
drop policy if exists status_events_insert_agency_owned_service on public.status_events;
drop policy if exists status_events_update_admin_operator on public.status_events;
drop policy if exists status_events_delete_admin_operator on public.status_events;

create policy status_events_select_admin_operator_tenant on public.status_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_select_driver_assigned on public.status_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and public.is_driver_assigned_service(service_id)
);

create policy status_events_select_agency_owned_service on public.status_events
for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and exists (
    select 1
    from public.services as s
    where s.id = service_id
      and s.tenant_id = public.current_tenant_id()
      and s.created_by_user_id = auth.uid()
  )
);

create policy status_events_insert_admin_operator on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_insert_driver_assigned on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'driver'
  and by_user_id = auth.uid()
  and public.is_driver_assigned_service(service_id)
);

create policy status_events_insert_agency_owned_service on public.status_events
for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() = 'agency'
  and by_user_id = auth.uid()
  and exists (
    select 1
    from public.services as s
    where s.id = service_id
      and s.tenant_id = public.current_tenant_id()
      and s.created_by_user_id = auth.uid()
  )
);

create policy status_events_update_admin_operator on public.status_events
for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

create policy status_events_delete_admin_operator on public.status_events
for delete
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);
