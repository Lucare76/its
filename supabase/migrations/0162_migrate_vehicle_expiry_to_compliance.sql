-- ═══════════════════════════════════════════════════════════════════════════
-- 0162 — Migrazione dati scadenze esistenti → nuove tabelle compliance
-- Legge insurance_expiry e inspection_expiry già presenti su vehicles
-- e crea i record corrispondenti in vehicle_insurances / vehicle_inspections.
-- Idempotente: salta i veicoli che hanno già un record is_current=true.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Assicurazioni ────────────────────────────────────────────────────────────
insert into public.vehicle_insurances (
  tenant_id,
  vehicle_id,
  company,
  expiry_date,
  is_current,
  notes,
  created_at
)
select
  v.tenant_id,
  v.id,
  'Da verificare'   as company,
  v.insurance_expiry as expiry_date,
  true               as is_current,
  'Importato da campo vehicles.insurance_expiry' as notes,
  now()              as created_at
from public.vehicles v
where v.insurance_expiry is not null
  and not exists (
    select 1
    from public.vehicle_insurances vi
    where vi.vehicle_id = v.id
      and vi.is_current = true
  );

-- ── Collaudi ─────────────────────────────────────────────────────────────────
-- inspection_date è required: usiamo la data corrente come placeholder
-- (la data reale del collaudo non era tracciata prima)
insert into public.vehicle_inspections (
  tenant_id,
  vehicle_id,
  inspection_date,
  expiry_date,
  outcome,
  is_current,
  notes,
  created_at
)
select
  v.tenant_id,
  v.id,
  current_date        as inspection_date,
  v.inspection_expiry as expiry_date,
  'passed'            as outcome,
  true                as is_current,
  'Importato da campo vehicles.inspection_expiry (data collaudo da verificare)' as notes,
  now()               as created_at
from public.vehicles v
where v.inspection_expiry is not null
  and not exists (
    select 1
    from public.vehicle_inspections vi
    where vi.vehicle_id = v.id
      and vi.is_current = true
  );
