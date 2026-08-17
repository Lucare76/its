-- Migration: Hardening Sprint 2A — complete the pricing schema drift.
--
-- Migrations 0012_tariffs_and_margins.sql and 0014_pricing_advanced_rules.sql
-- were only ever partially applied against the real database: a live audit
-- (information_schema.columns / to_regclass / pg_constraint / pg_indexes)
-- confirmed a non-contiguous subset of their `add column if not exists` /
-- `create table if not exists` statements never actually ran, while others
-- from the very same files did. This migration re-declares only what that
-- audit confirmed is still missing today. Every statement below is
-- idempotent (IF NOT EXISTS / DO $$ IF NOT EXISTS guards), so it is safe to
-- run even though some sibling objects from 0012/0014 already exist.
--
-- Deliberately NOT touched: services.pricing_confidence (existing TEXT
-- column, CHECK values 'low'/'medium'/'high'). Hardening Sprint 2A.1 audited
-- this collision in full: the column is a relic of an older, apparently
-- abandoned pricing schema (see also the real, code-unused
-- services.pricing_rule_id FK to price_rules, services.pricing_source,
-- services.pricing_explanation, services.pricing_matched_at) — zero
-- application code reads or writes the low/medium/high semantics anywhere
-- in this repo, and all 7700 existing rows have pricing_confidence = NULL
-- today (verified directly against the real DB). Rather than repurpose that
-- column (ALTER COLUMN TYPE + DROP/re-ADD its CHECK — a heavier, less
-- reversible change for zero benefit, since there is no live data or code
-- to preserve continuity with), section 2 below adds a new, separately
-- named column — services.pricing_match_confidence (integer, 0-100) — and
-- lib/server/pricing-matching.ts / app/api/pricing/override now write to
-- that column instead. The legacy pricing_confidence column and its CHECK
-- constraint are left completely untouched by this migration.

-- 1) Enum type needed below (pricing_apply_mode already exists on the real
-- DB — confirmed via pg_type — so it is intentionally not re-declared here).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pricing_match_quality') then
    create type public.pricing_match_quality as enum ('certain', 'partial', 'review');
  end if;
end $$;

-- 2) services: the 8 columns confirmed missing by the Hardening Sprint 2A
-- audit, plus pricing_match_confidence (Hardening Sprint 2A.1 — see above).
-- (agency_id, route_id, internal_cost_cents, public_price_cents,
-- agency_price_cents, final_price_cents, margin_cents already exist on the
-- real DB and are intentionally not touched here; pricing_confidence also
-- already exists but keeps its unrelated legacy semantics untouched.)
alter table public.services add column if not exists import_id uuid null references public.inbound_booking_imports (id) on delete set null;
alter table public.services add column if not exists applied_price_list_id uuid null references public.price_lists (id) on delete set null;
alter table public.services add column if not exists applied_pricing_rule_id uuid null references public.pricing_rules (id) on delete set null;
alter table public.services add column if not exists pricing_currency char(3) not null default 'EUR';
alter table public.services add column if not exists pricing_apply_mode public.pricing_apply_mode null;
alter table public.services add column if not exists pricing_applied_at timestamptz null;
alter table public.services add column if not exists pricing_manual_override boolean not null default false;
alter table public.services add column if not exists pricing_manual_override_reason text not null default '';
alter table public.services add column if not exists pricing_match_confidence integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'services_pricing_match_confidence_valid'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_pricing_match_confidence_valid
      check (pricing_match_confidence is null or (pricing_match_confidence >= 0 and pricing_match_confidence <= 100));
  end if;
end $$;

create index if not exists idx_services_import on public.services (import_id);
create index if not exists idx_services_pricing_rule on public.services (applied_pricing_rule_id);

-- 3) service_pricing: the entire table is confirmed missing
-- (to_regclass('public.service_pricing') returned null). Required by
-- lib/server/pricing-matching.ts, app/api/pricing/override,
-- app/api/pricing/margins. Includes manual_override/manual_override_reason
-- (originally added to this table by migration 0014) directly in the CREATE
-- — the table never existed, so there is no partial-application concern for
-- those two columns specifically.
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
  manual_override boolean not null default false,
  manual_override_reason text not null default '',
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

create index if not exists idx_service_pricing_service_created on public.service_pricing (service_id, created_at desc);
create index if not exists idx_service_pricing_tenant_created on public.service_pricing (tenant_id, created_at desc);
create index if not exists idx_service_pricing_rule on public.service_pricing (pricing_rule_id);

alter table public.service_pricing enable row level security;

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

-- 4) pricing_rules: 6 columns from migration 0014, confirmed missing. Their
-- absence makes lib/server/pricing-matching.ts's rule-candidate SELECT fail
-- outright today, so no rule can ever be matched (always falls back).
alter table public.pricing_rules
  add column if not exists vehicle_type text null,
  add column if not exists time_from time null,
  add column if not exists time_to time null,
  add column if not exists season_from date null,
  add column if not exists season_to date null,
  add column if not exists needs_manual_review boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pricing_rules_vehicle_type_not_blank'
      and conrelid = 'public.pricing_rules'::regclass
  ) then
    alter table public.pricing_rules
      add constraint pricing_rules_vehicle_type_not_blank
      check (vehicle_type is null or length(trim(vehicle_type)) > 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pricing_rules_time_window_valid'
      and conrelid = 'public.pricing_rules'::regclass
  ) then
    alter table public.pricing_rules
      add constraint pricing_rules_time_window_valid
      check (time_from is null or time_to is null or time_to >= time_from);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pricing_rules_season_window_valid'
      and conrelid = 'public.pricing_rules'::regclass
  ) then
    alter table public.pricing_rules
      add constraint pricing_rules_season_window_valid
      check (season_from is null or season_to is null or season_to >= season_from);
  end if;
end $$;

create index if not exists idx_pricing_rules_vehicle_time_season
  on public.pricing_rules (tenant_id, active, vehicle_type, time_from, time_to, season_from, season_to, priority);

-- 5) inbound_booking_imports: 4 columns from migration 0014, confirmed
-- missing. Breaks the audit-trail insert in pricing-matching.ts AND
-- app/api/pricing/matches (GET select, POST approve/reject/reapply updates).
alter table public.inbound_booking_imports
  add column if not exists match_quality public.pricing_match_quality null,
  add column if not exists review_required boolean not null default false,
  add column if not exists reviewed_by_user_id uuid null references auth.users (id) on delete set null,
  add column if not exists reviewed_at timestamptz null;

create index if not exists idx_inbound_booking_imports_quality
  on public.inbound_booking_imports (tenant_id, match_quality, review_required, created_at desc);
