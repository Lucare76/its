-- ═══════════════════════════════════════════════════════════════════════════
-- 0160 — Vehicle Compliance Module
-- Scadenze automezzi: assicurazione, collaudo, estintori, tachigrafo autisti
-- Storico rinnovi, upload documenti PDF, bucket vehicle-documents
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Bucket documenti veicoli ──────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vehicle-documents',
  'vehicle-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Accesso: solo utenti autenticati del tenant
drop policy if exists vehicle_documents_select on storage.objects;
create policy vehicle_documents_select
  on storage.objects for select
  using (
    bucket_id = 'vehicle-documents'
    and auth.uid() is not null
  );

drop policy if exists vehicle_documents_insert on storage.objects;
create policy vehicle_documents_insert
  on storage.objects for insert
  with check (
    bucket_id = 'vehicle-documents'
    and auth.uid() is not null
  );

drop policy if exists vehicle_documents_delete on storage.objects;
create policy vehicle_documents_delete
  on storage.objects for delete
  using (
    bucket_id = 'vehicle-documents'
    and auth.uid() is not null
  );

-- ── 2. Libretto di circolazione su vehicles ──────────────────────────────────
alter table public.vehicles
  add column if not exists libretto_document_path text null,
  add column if not exists libretto_uploaded_at   timestamptz null;

-- ── 3. Carta tachigrafo su driver_profiles ───────────────────────────────────
alter table public.driver_profiles
  add column if not exists tachograph_card_number        text null,
  add column if not exists tachograph_card_expiry        date null,
  add column if not exists tachograph_card_document_path text null,
  add column if not exists license_number                text null,
  add column if not exists license_expiry                date null;

create index if not exists idx_driver_profiles_tacho_expiry
  on public.driver_profiles(tenant_id, tachograph_card_expiry)
  where tachograph_card_expiry is not null;

-- ── 4. Assicurazioni (1:N per storico) ──────────────────────────────────────
create table if not exists public.vehicle_insurances (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  vehicle_id        uuid not null references public.vehicles(id) on delete cascade,
  company           text not null,
  policy_number     text,
  expiry_date       date not null,
  annual_amount_cents integer,
  document_path     text,
  notes             text,
  is_current        boolean not null default true,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_vehicle_insurances_vehicle
  on public.vehicle_insurances(vehicle_id, expiry_date desc);
create index if not exists idx_vehicle_insurances_tenant_expiry
  on public.vehicle_insurances(tenant_id, expiry_date)
  where is_current = true;

alter table public.vehicle_insurances enable row level security;

drop policy if exists vehicle_insurances_tenant on public.vehicle_insurances;
create policy vehicle_insurances_tenant on public.vehicle_insurances
  for all
  using (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ))
  with check (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ));

-- ── 5. Revisioni/Collaudi (1:N per storico) ─────────────────────────────────
create table if not exists public.vehicle_inspections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  vehicle_id           uuid not null references public.vehicles(id) on delete cascade,
  inspection_date      date not null,
  expiry_date          date not null,
  inspection_center    text,
  outcome              text check (outcome in ('passed', 'failed', 'pending')),
  outcome_notes        text,
  document_path        text,
  notes                text,
  is_current           boolean not null default true,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists idx_vehicle_inspections_vehicle
  on public.vehicle_inspections(vehicle_id, expiry_date desc);
create index if not exists idx_vehicle_inspections_tenant_expiry
  on public.vehicle_inspections(tenant_id, expiry_date)
  where is_current = true;

alter table public.vehicle_inspections enable row level security;

drop policy if exists vehicle_inspections_tenant on public.vehicle_inspections;
create policy vehicle_inspections_tenant on public.vehicle_inspections
  for all
  using (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ))
  with check (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ));

-- ── 6. Estintori (1:N per mezzo, più estintori possibili) ───────────────────
create table if not exists public.vehicle_extinguishers (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  vehicle_id           uuid not null references public.vehicles(id) on delete cascade,
  serial_number        text,
  last_revision_date   date,
  expiry_date          date not null,
  document_path        text,
  notes                text,
  active               boolean not null default true,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists idx_vehicle_extinguishers_vehicle
  on public.vehicle_extinguishers(vehicle_id, expiry_date);
create index if not exists idx_vehicle_extinguishers_tenant_expiry
  on public.vehicle_extinguishers(tenant_id, expiry_date)
  where active = true;

alter table public.vehicle_extinguishers enable row level security;

drop policy if exists vehicle_extinguishers_tenant on public.vehicle_extinguishers;
create policy vehicle_extinguishers_tenant on public.vehicle_extinguishers
  for all
  using (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ))
  with check (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ));

-- ── 7. Storico rinnovi (audit trail) ────────────────────────────────────────
create table if not exists public.vehicle_compliance_history (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  vehicle_id      uuid references public.vehicles(id) on delete set null,
  driver_id       uuid references public.driver_profiles(id) on delete set null,
  compliance_type text not null check (compliance_type in (
    'insurance', 'inspection', 'extinguisher', 'tachograph', 'road_tax', 'libretto'
  )),
  action          text not null check (action in ('created', 'renewed', 'archived', 'uploaded')),
  old_expiry_date date,
  new_expiry_date date,
  ref_id          uuid,
  notes           text,
  performed_by    uuid references auth.users(id) on delete set null,
  performed_at    timestamptz not null default now()
);

create index if not exists idx_compliance_history_vehicle
  on public.vehicle_compliance_history(vehicle_id, performed_at desc)
  where vehicle_id is not null;
create index if not exists idx_compliance_history_driver
  on public.vehicle_compliance_history(driver_id, performed_at desc)
  where driver_id is not null;

alter table public.vehicle_compliance_history enable row level security;

drop policy if exists compliance_history_tenant on public.vehicle_compliance_history;
create policy compliance_history_tenant on public.vehicle_compliance_history
  for select
  using (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ));

drop policy if exists compliance_history_insert on public.vehicle_compliance_history;
create policy compliance_history_insert on public.vehicle_compliance_history
  for insert
  with check (tenant_id in (
    select tenant_id from public.memberships where user_id = auth.uid()
  ));
