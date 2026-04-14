-- Impegni non operativi per automezzo (collaudo, officina, fermo, ecc.)
-- Blocca la disponibilità del mezzo nella data indicata.
-- Gli operatori vedono tipo + note; nessun dato sensibile (costi, fornitori).

create table if not exists public.vehicle_commitments (
  id              uuid        default gen_random_uuid() primary key,
  tenant_id       uuid        not null,
  vehicle_id      uuid        not null,
  commitment_date date        not null,
  commitment_type text        not null
                    check (commitment_type in ('collaudo','officina','fermo_amministrativo','altro')),
  notes           text,
  created_by      uuid,
  created_at      timestamptz not null default now()
);

create index if not exists vehicle_commitments_vehicle
  on public.vehicle_commitments (tenant_id, vehicle_id, commitment_date);
create index if not exists vehicle_commitments_date
  on public.vehicle_commitments (tenant_id, commitment_date);
