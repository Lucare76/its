-- Migration: richer agency registry profiles for parser matching and default pricing setup

alter table public.agencies
  add column if not exists legal_name text null;

alter table public.agencies
  add column if not exists billing_name text null;

alter table public.agencies
  add column if not exists contact_email text null;

alter table public.agencies
  add column if not exists booking_email text null;

alter table public.agencies
  add column if not exists phone text null;

alter table public.agencies
  add column if not exists parser_key_hint text null;

alter table public.agencies
  add column if not exists sender_domains jsonb not null default '[]'::jsonb;

alter table public.agencies
  add column if not exists default_enabled_booking_kinds jsonb not null default '[]'::jsonb;

alter table public.agencies
  add column if not exists default_pricing_notes text not null default '';

alter table public.agencies
  add column if not exists notes text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agencies_sender_domains_is_array'
      and conrelid = 'public.agencies'::regclass
  ) then
    alter table public.agencies
      add constraint agencies_sender_domains_is_array
      check (jsonb_typeof(sender_domains) = 'array');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agencies_default_enabled_booking_kinds_is_array'
      and conrelid = 'public.agencies'::regclass
  ) then
    alter table public.agencies
      add constraint agencies_default_enabled_booking_kinds_is_array
      check (jsonb_typeof(default_enabled_booking_kinds) = 'array');
  end if;
end $$;

create index if not exists idx_agencies_tenant_booking_email
  on public.agencies (tenant_id, booking_email);

create index if not exists idx_agencies_tenant_contact_email
  on public.agencies (tenant_id, contact_email);
