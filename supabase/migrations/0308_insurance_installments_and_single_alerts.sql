-- Scadenze flotta:
-- 1. Assicurazione pagata in due rate: frazionamento, importo rata e data della
--    seconda rata (per il relativo avviso).
-- 2. Registro degli avvisi inviati: ogni scadenza riceve UNA email di preavviso
--    e UNA il giorno della scadenza, mai ripetute (prima: riepilogo ogni giorno).

alter table public.vehicle_insurances
  add column if not exists payment_frequency text not null default 'annual',
  add column if not exists installment_amount_cents integer null,
  add column if not exists second_installment_date date null;

alter table public.vehicle_insurances drop constraint if exists vehicle_insurances_payment_frequency_check;
alter table public.vehicle_insurances add constraint vehicle_insurances_payment_frequency_check
  check (payment_frequency in ('annual', 'semiannual'));

alter table public.vehicle_insurances drop constraint if exists vehicle_insurances_installment_check;
alter table public.vehicle_insurances add constraint vehicle_insurances_installment_check
  check (
    (installment_amount_cents is null or installment_amount_cents >= 0)
    and (payment_frequency = 'semiannual' or (installment_amount_cents is null and second_installment_date is null))
  );

create table if not exists public.vehicle_compliance_alerts_sent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid null references public.vehicles(id) on delete cascade,
  -- chi/cosa scade: id mezzo, "driver:<id>" per la carta tachigrafo, "ext:<id>" per l'estintore
  subject_key text not null check (char_length(subject_key) between 1 and 120),
  doc_type text not null check (doc_type in (
    'insurance', 'insurance_installment', 'inspection', 'road_tax',
    'extinguisher', 'tachograph_card', 'tachograph_calibration'
  )),
  due_date date not null,
  stage text not null check (stage in ('advance', 'due')),
  sent_at timestamptz not null default now()
);

create unique index if not exists vehicle_compliance_alerts_sent_once
  on public.vehicle_compliance_alerts_sent(tenant_id, subject_key, doc_type, due_date, stage);
create index if not exists vehicle_compliance_alerts_sent_vehicle_idx
  on public.vehicle_compliance_alerts_sent(tenant_id, vehicle_id, sent_at desc);

alter table public.vehicle_compliance_alerts_sent enable row level security;
revoke all on public.vehicle_compliance_alerts_sent from anon, authenticated;
