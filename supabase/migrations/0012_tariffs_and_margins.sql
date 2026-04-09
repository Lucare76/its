-- Migration: Tariffe e Margini (agenzie, tratte, listini, regole, import/matching, pricing finale)

-- 1) Enum / tipi di supporto
do $$
begin
  if not exists (select 1 from pg_type where typname = 'route_point_type') then
    create type public.route_point_type as enum ('port', 'hotel', 'address', 'custom');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'pricing_rule_kind') then
    create type public.pricing_rule_kind as enum ('fixed', 'per_pax');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'import_source_type') then
    create type public.import_source_type as enum ('email_body', 'pdf_attachment', 'manual');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'pricing_match_status') then
    create type public.pricing_match_status as enum ('pending', 'matched', 'needs_review', 'applied', 'rejected');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'pricing_apply_mode') then
    create type public.pricing_apply_mode as enum ('manual', 'auto_rule', 'fallback');
  end if;
end $$;

-- 2) Tabelle anagrafiche / configurazione
create table if not exists public.agencies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  external_code text null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agency_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  agency_id uuid not null references public.agencies (id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  constraint agency_aliases_alias_not_blank check (length(trim(alias)) > 0)
);

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  origin_type public.route_point_type not null default 'custom',
  origin_label text not null,
  destination_type public.route_point_type not null default 'custom',
  destination_label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint routes_name_not_blank check (length(trim(name)) > 0),
  constraint routes_origin_not_blank check (length(trim(origin_label)) > 0),
  constraint routes_destination_not_blank check (length(trim(destination_label)) > 0)
);

create table if not exists public.price_lists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  currency char(3) not null default 'EUR',
  valid_from date not null,
  valid_to date null,
  is_default boolean not null default false,
  active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_lists_name_not_blank check (length(trim(name)) > 0),
  constraint price_lists_valid_range check (valid_to is null or valid_to >= valid_from),
  constraint price_lists_currency_upper check (currency = upper(currency))
);

create table if not exists public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  route_id uuid not null references public.routes (id) on delete cascade,
  agency_id uuid null references public.agencies (id) on delete set null,
  service_type public.service_type null,
  direction public.service_direction null,
  pax_min integer not null default 1,
  pax_max integer null,
  rule_kind public.pricing_rule_kind not null default 'fixed',
  internal_cost_cents integer not null,
  public_price_cents integer not null,
  agency_price_cents integer null,
  priority integer not null default 100,
  active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_rules_pax_range check (pax_min >= 1 and (pax_max is null or pax_max >= pax_min)),
  constraint pricing_rules_internal_cost_nonneg check (internal_cost_cents >= 0),
  constraint pricing_rules_public_price_nonneg check (public_price_cents >= 0),
  constraint pricing_rules_agency_price_nonneg check (agency_price_cents is null or agency_price_cents >= 0)
);

-- 3) Import prenotazioni e pricing applicato
create table if not exists public.inbound_booking_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  inbound_email_id uuid null references public.inbound_emails (id) on delete set null,
  service_id uuid null references public.services (id) on delete set null,
  source_type public.import_source_type not null default 'email_body',
  source_reference text null,
  raw_payload jsonb not null default '{}'::jsonb,
  extracted_json jsonb not null default '{}'::jsonb,
  normalized_agency_name text null,
  normalized_route_name text null,
  service_date date null,
  service_time time null,
  pax integer null,
  agency_id uuid null references public.agencies (id) on delete set null,
  route_id uuid null references public.routes (id) on delete set null,
  pricing_rule_id uuid null references public.pricing_rules (id) on delete set null,
  match_status public.pricing_match_status not null default 'pending',
  match_confidence integer null,
  match_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inbound_booking_imports_pax_valid check (pax is null or (pax > 0 and pax <= 99)),
  constraint inbound_booking_imports_confidence_valid check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 100))
);

create table if not exists public.service_pricing (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  price_list_id uuid null references public.price_lists (id) on delete set null,
  pricing_rule_id uuid null references public.pricing_rules (id) on delete set null,
  agency_id uuid null references public.agencies (id) on delete set null,
  route_id uuid null references public.routes (id) on delete set null,
  currency char(3) not null default 'EUR',
  internal_cost_cents integer not null,
  public_price_cents integer not null,
  agency_price_cents integer null,
  final_price_cents integer not null,
  margin_cents integer generated always as (final_price_cents - internal_cost_cents) stored,
  apply_mode public.pricing_apply_mode not null default 'manual',
  confidence integer null,
  snapshot_json jsonb not null default '{}'::jsonb,
  created_by_user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint service_pricing_currency_upper check (currency = upper(currency)),
  constraint service_pricing_internal_nonneg check (internal_cost_cents >= 0),
  constraint service_pricing_public_nonneg check (public_price_cents >= 0),
  constraint service_pricing_agency_nonneg check (agency_price_cents is null or agency_price_cents >= 0),
  constraint service_pricing_final_nonneg check (final_price_cents >= 0),
  constraint service_pricing_confidence_valid check (confidence is null or (confidence >= 0 and confidence <= 100))
);

-- 4) Aggiornamento tabella services (riferimenti pricing/matching)
alter table public.services add column if not exists agency_id uuid null references public.agencies (id) on delete set null;
alter table public.services add column if not exists route_id uuid null references public.routes (id) on delete set null;
alter table public.services add column if not exists import_id uuid null references public.inbound_booking_imports (id) on delete set null;
alter table public.services add column if not exists applied_price_list_id uuid null references public.price_lists (id) on delete set null;
alter table public.services add column if not exists applied_pricing_rule_id uuid null references public.pricing_rules (id) on delete set null;
alter table public.services add column if not exists pricing_currency char(3) not null default 'EUR';
alter table public.services add column if not exists internal_cost_cents integer null;
alter table public.services add column if not exists public_price_cents integer null;
alter table public.services add column if not exists agency_price_cents integer null;
alter table public.services add column if not exists final_price_cents integer null;
alter table public.services add column if not exists margin_cents integer null;
alter table public.services add column if not exists pricing_apply_mode public.pricing_apply_mode null;
alter table public.services add column if not exists pricing_confidence integer null;
alter table public.services add column if not exists pricing_applied_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_internal_cost_nonneg'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_internal_cost_nonneg check (internal_cost_cents is null or internal_cost_cents >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_public_price_nonneg'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_public_price_nonneg check (public_price_cents is null or public_price_cents >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_agency_price_nonneg'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_agency_price_nonneg check (agency_price_cents is null or agency_price_cents >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_final_price_nonneg'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_final_price_nonneg check (final_price_cents is null or final_price_cents >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_pricing_confidence_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_pricing_confidence_valid check (pricing_confidence is null or (pricing_confidence >= 0 and pricing_confidence <= 100));
  end if;
end $$;

-- 5) Indici e vincoli univoci utili
create unique index if not exists uq_agencies_tenant_name on public.agencies (tenant_id, lower(name));
create index if not exists idx_agencies_tenant_active on public.agencies (tenant_id, active, created_at desc);
create unique index if not exists uq_agency_aliases_tenant_alias on public.agency_aliases (tenant_id, lower(alias));
create index if not exists idx_agency_aliases_agency on public.agency_aliases (agency_id);

create unique index if not exists uq_routes_tenant_name on public.routes (tenant_id, lower(name));
create index if not exists idx_routes_tenant_active on public.routes (tenant_id, active, created_at desc);

create index if not exists idx_price_lists_tenant_dates on public.price_lists (tenant_id, active, valid_from, valid_to);
create unique index if not exists uq_price_lists_default_per_tenant on public.price_lists (tenant_id) where (is_default and active);

create index if not exists idx_pricing_rules_match on public.pricing_rules (tenant_id, active, route_id, agency_id, service_type, direction, pax_min, pax_max, priority);
create index if not exists idx_pricing_rules_price_list on public.pricing_rules (price_list_id, active, priority);

create index if not exists idx_inbound_booking_imports_tenant_status on public.inbound_booking_imports (tenant_id, match_status, created_at desc);
create index if not exists idx_inbound_booking_imports_email on public.inbound_booking_imports (inbound_email_id);
create index if not exists idx_inbound_booking_imports_service on public.inbound_booking_imports (service_id);
create index if not exists idx_inbound_booking_imports_match_keys on public.inbound_booking_imports (tenant_id, agency_id, route_id, pricing_rule_id);

create index if not exists idx_service_pricing_service_created on public.service_pricing (service_id, created_at desc);
create index if not exists idx_service_pricing_tenant_created on public.service_pricing (tenant_id, created_at desc);
create index if not exists idx_service_pricing_rule on public.service_pricing (pricing_rule_id);

create index if not exists idx_services_agency on public.services (tenant_id, agency_id);
create index if not exists idx_services_route on public.services (tenant_id, route_id);
create index if not exists idx_services_import on public.services (import_id);
create index if not exists idx_services_pricing_rule on public.services (applied_pricing_rule_id);
create index if not exists idx_services_pricing_prices on public.services (tenant_id, final_price_cents, margin_cents);

-- 6) RLS: estensione compatibile con schema attuale
alter table public.agencies enable row level security;
alter table public.agency_aliases enable row level security;
alter table public.routes enable row level security;
alter table public.price_lists enable row level security;
alter table public.pricing_rules enable row level security;
alter table public.inbound_booking_imports enable row level security;
alter table public.service_pricing enable row level security;

drop policy if exists agencies_select_tenant_member on public.agencies;
drop policy if exists agencies_insert_admin_operator on public.agencies;
drop policy if exists agencies_update_admin_operator on public.agencies;
drop policy if exists agencies_delete_admin_operator on public.agencies;

create policy agencies_select_tenant_member on public.agencies
for select using (tenant_id = public.current_tenant_id());
create policy agencies_insert_admin_operator on public.agencies
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy agencies_update_admin_operator on public.agencies
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy agencies_delete_admin_operator on public.agencies
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

drop policy if exists agency_aliases_select_tenant_member on public.agency_aliases;
drop policy if exists agency_aliases_insert_admin_operator on public.agency_aliases;
drop policy if exists agency_aliases_update_admin_operator on public.agency_aliases;
drop policy if exists agency_aliases_delete_admin_operator on public.agency_aliases;

create policy agency_aliases_select_tenant_member on public.agency_aliases
for select using (tenant_id = public.current_tenant_id());
create policy agency_aliases_insert_admin_operator on public.agency_aliases
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy agency_aliases_update_admin_operator on public.agency_aliases
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy agency_aliases_delete_admin_operator on public.agency_aliases
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

drop policy if exists routes_select_tenant_member on public.routes;
drop policy if exists routes_insert_admin_operator on public.routes;
drop policy if exists routes_update_admin_operator on public.routes;
drop policy if exists routes_delete_admin_operator on public.routes;

create policy routes_select_tenant_member on public.routes
for select using (tenant_id = public.current_tenant_id());
create policy routes_insert_admin_operator on public.routes
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy routes_update_admin_operator on public.routes
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy routes_delete_admin_operator on public.routes
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

drop policy if exists price_lists_select_tenant_member on public.price_lists;
drop policy if exists price_lists_insert_admin_operator on public.price_lists;
drop policy if exists price_lists_update_admin_operator on public.price_lists;
drop policy if exists price_lists_delete_admin_operator on public.price_lists;

create policy price_lists_select_tenant_member on public.price_lists
for select using (tenant_id = public.current_tenant_id());
create policy price_lists_insert_admin_operator on public.price_lists
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy price_lists_update_admin_operator on public.price_lists
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy price_lists_delete_admin_operator on public.price_lists
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

drop policy if exists pricing_rules_select_tenant_member on public.pricing_rules;
drop policy if exists pricing_rules_insert_admin_operator on public.pricing_rules;
drop policy if exists pricing_rules_update_admin_operator on public.pricing_rules;
drop policy if exists pricing_rules_delete_admin_operator on public.pricing_rules;

create policy pricing_rules_select_tenant_member on public.pricing_rules
for select using (tenant_id = public.current_tenant_id());
create policy pricing_rules_insert_admin_operator on public.pricing_rules
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy pricing_rules_update_admin_operator on public.pricing_rules
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy pricing_rules_delete_admin_operator on public.pricing_rules
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

drop policy if exists inbound_booking_imports_select_tenant_member on public.inbound_booking_imports;
drop policy if exists inbound_booking_imports_insert_admin_operator on public.inbound_booking_imports;
drop policy if exists inbound_booking_imports_update_admin_operator on public.inbound_booking_imports;
drop policy if exists inbound_booking_imports_delete_admin_operator on public.inbound_booking_imports;

create policy inbound_booking_imports_select_tenant_member on public.inbound_booking_imports
for select using (tenant_id = public.current_tenant_id());
create policy inbound_booking_imports_insert_admin_operator on public.inbound_booking_imports
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy inbound_booking_imports_update_admin_operator on public.inbound_booking_imports
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy inbound_booking_imports_delete_admin_operator on public.inbound_booking_imports
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));

drop policy if exists service_pricing_select_tenant_member on public.service_pricing;
drop policy if exists service_pricing_insert_admin_operator on public.service_pricing;
drop policy if exists service_pricing_update_admin_operator on public.service_pricing;
drop policy if exists service_pricing_delete_admin_operator on public.service_pricing;

create policy service_pricing_select_tenant_member on public.service_pricing
for select using (tenant_id = public.current_tenant_id());
create policy service_pricing_insert_admin_operator on public.service_pricing
for insert with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy service_pricing_update_admin_operator on public.service_pricing
for update
using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'))
with check (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
create policy service_pricing_delete_admin_operator on public.service_pricing
for delete using (tenant_id = public.current_tenant_id() and public.current_user_role() in ('admin', 'operator'));
