-- Tabella autisti (roster fisico, senza account auth.users)
-- Usata da fleet-ops per associare un autista abituale a un mezzo.

create table if not exists public.driver_profiles (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  full_name  text not null,
  phone      text null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_driver_profiles_tenant_id on public.driver_profiles (tenant_id);

-- Collega un autista del roster al veicolo come "autista abituale"
alter table public.vehicles
  add column if not exists habitual_driver_profile_id uuid null
    references public.driver_profiles (id) on delete set null;

alter table public.driver_profiles enable row level security;

drop policy if exists driver_profiles_tenant_select on public.driver_profiles;
create policy driver_profiles_tenant_select on public.driver_profiles
for select
using (tenant_id = public.current_tenant_id());

drop policy if exists driver_profiles_admin_operator_all on public.driver_profiles;
create policy driver_profiles_admin_operator_all on public.driver_profiles
for all
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_role() in ('admin', 'operator')
);

-- ── Seed autisti Ischia Transfer Service ──────────────────────────────────────
insert into driver_profiles (tenant_id, full_name, phone)
values
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ANDY',             '3427771061'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'GIUSEPPE',         '3343411775'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'MARIO',            '3351812522'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'LEO',              '3387406460'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ILARIA',           '3479245399'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'JAMAL',            '3773536817'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ALBERTO SEBON',    '3923533798'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ANGIOLETTO',       null),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'BIAGIO ISCHIA',    '3407230797'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'BIAGIO POZZUOLI',  '3381937706'),
  ('d200b89a-64c7-4f8d-a430-95a33b83047a', 'ALBERTO D''ABUNDO','3347743084')
on conflict do nothing;
