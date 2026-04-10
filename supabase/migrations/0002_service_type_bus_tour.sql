-- Migration: service_type => transfer | bus_tour, plus dedicated bus_tour fields
-- Safe to run in Supabase SQL Editor after 0001_schema.sql/bootstrap.sql.

do $$
begin
  begin
    alter type public.service_type add value if not exists 'bus_tour';
  exception
    when duplicate_object then null;
  end;
end
$$;

alter table public.services
  add column if not exists tour_name text null,
  add column if not exists capacity integer null,
  add column if not exists bus_plate text null;

-- Keep backward compatibility with older columns if still present
alter table public.services add column if not exists excursion_name text null;
alter table public.services add column if not exists bus_capacity integer null;
alter table public.services add column if not exists guide_name text null;

-- Legacy service types become transfer by default
update public.services
set service_type = 'transfer'
where service_type::text in ('excursion', 'shuttle', 'custom');

-- Data backfill from legacy fields
update public.services
set
  tour_name = coalesce(tour_name, excursion_name),
  capacity = coalesce(capacity, bus_capacity)
where excursion_name is not null or bus_capacity is not null;

-- Keep export audit aligned with supported types
update public.export_audits
set service_type = 'transfer'
where service_type not in ('all', 'transfer', 'bus_tour');

alter table public.export_audits
  drop constraint if exists export_audits_service_type_check;
alter table public.export_audits
  add constraint export_audits_service_type_check
  check (service_type in ('all', 'transfer', 'bus_tour'));
