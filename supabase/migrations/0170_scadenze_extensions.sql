-- Migration 0170: Estensioni modulo scadenze automezzi
-- - Scadenze opzionali per mezzo (cronotachigrafo, estintore)
-- - Proroghe configurabili per tipo scadenza
-- - Costi per mezzo (storico pagamenti assicurativi)

-- ── 1. Flags scadenze opzionali in vehicles ────────────────────────────────

alter table public.vehicles
  add column if not exists tachograph_enabled   boolean not null default false,
  add column if not exists extinguisher_enabled boolean not null default true;

comment on column public.vehicles.tachograph_enabled   is 'Monitorare scadenza cronotachigrafo per questo mezzo';
comment on column public.vehicles.extinguisher_enabled is 'Monitorare scadenza estintore per questo mezzo';

-- ── 2. Proroghe configurabili per tipo scadenza ────────────────────────────

create table if not exists public.vehicle_compliance_grace_periods (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  compliance_type text not null,   -- insurance | inspection | tachograph | extinguisher
  grace_days   int  not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   uuid null references auth.users(id) on delete set null,
  constraint vehicle_compliance_grace_periods_type_check
    check (compliance_type in ('insurance', 'inspection', 'tachograph', 'extinguisher')),
  unique (tenant_id, compliance_type)
);

alter table public.vehicle_compliance_grace_periods enable row level security;

create policy "grace_periods_tenant_read" on public.vehicle_compliance_grace_periods
  for select using (
    tenant_id = (select tenant_id from public.memberships where user_id = auth.uid() limit 1)
  );

create policy "grace_periods_admin_write" on public.vehicle_compliance_grace_periods
  for all using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and tenant_id = vehicle_compliance_grace_periods.tenant_id
        and role in ('admin', 'supervisor')
    )
  );

-- Valori default per tenant esistenti
insert into public.vehicle_compliance_grace_periods (tenant_id, compliance_type, grace_days)
select id, 'insurance',   15 from public.tenants
union all
select id, 'inspection',  25 from public.tenants
union all
select id, 'tachograph',   0 from public.tenants
union all
select id, 'extinguisher', 0 from public.tenants
on conflict (tenant_id, compliance_type) do nothing;

-- ── 3. Costi assicurativi per mezzo ───────────────────────────────────────

create table if not exists public.vehicle_compliance_costs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  compliance_type text not null,
  amount_cents    int  not null,          -- importo in centesimi
  duration_months int  null,              -- durata copertura in mesi
  paid_at         date not null,
  provider        text null,              -- es. "AXA", "Centro Rev. Ischia"
  notes           text null,
  created_at      timestamptz not null default now(),
  created_by      uuid null references auth.users(id) on delete set null,
  constraint vehicle_compliance_costs_type_check
    check (compliance_type in ('insurance', 'inspection', 'tachograph', 'extinguisher', 'road_tax', 'other'))
);

create index if not exists idx_vehicle_compliance_costs_vehicle
  on public.vehicle_compliance_costs(tenant_id, vehicle_id);

alter table public.vehicle_compliance_costs enable row level security;

create policy "compliance_costs_tenant_read" on public.vehicle_compliance_costs
  for select using (
    tenant_id = (select tenant_id from public.memberships where user_id = auth.uid() limit 1)
  );

create policy "compliance_costs_admin_write" on public.vehicle_compliance_costs
  for all using (
    exists (
      select 1 from public.memberships
      where user_id = auth.uid()
        and tenant_id = vehicle_compliance_costs.tenant_id
        and role in ('admin', 'supervisor', 'operator')
    )
  );
