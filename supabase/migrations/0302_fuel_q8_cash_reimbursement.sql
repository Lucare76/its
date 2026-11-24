-- Nuovi modi di pagamento del rifornimento (vehicle_fuel.invoice_supplier):
--   ENI, UTA, Q8  = carta carburante del fornitore (arriva nella sua fattura)
--   CONTANTI      = pagato dall'autista di tasca sua: nessuna fattura carta,
--                   va rimborsato all'autista e serve lo scontrino/fattura singola.
-- Il confronto fatture resta solo ENI/UTA (fuel_invoice_imports invariata):
-- per Q8 servirà un lettore del suo PDF quando arriverà la prima fattura.

-- Il vincolo originale (0295) è anonimo: lo togliamo cercandolo per contenuto.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.vehicle_fuel'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%invoice_supplier%'
      and pg_get_constraintdef(c.oid) not ilike '%reimbursed%'
  loop
    execute format('alter table public.vehicle_fuel drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.vehicle_fuel
  add constraint vehicle_fuel_invoice_supplier_check
    check (invoice_supplier is null or invoice_supplier in ('ENI', 'UTA', 'Q8', 'CONTANTI'));

-- Rimborso all'autista dei rifornimenti pagati in contanti.
alter table public.vehicle_fuel
  add column if not exists reimbursed_at timestamptz null,
  add column if not exists reimbursed_by uuid null references auth.users(id) on delete set null,
  add column if not exists reimbursement_note text null;

alter table public.vehicle_fuel
  drop constraint if exists vehicle_fuel_reimbursement_check,
  add constraint vehicle_fuel_reimbursement_check check (
    -- solo i contanti si rimborsano; "rimborsato da" solo se rimborsato
    (reimbursed_at is null or invoice_supplier = 'CONTANTI')
    and (reimbursed_by is null or reimbursed_at is not null)
    and (reimbursement_note is null or char_length(reimbursement_note) <= 500)
  );

-- Elenco "contanti da rimborsare".
create index if not exists idx_vehicle_fuel_cash_to_reimburse
  on public.vehicle_fuel(tenant_id, fuel_date desc)
  where invoice_supplier = 'CONTANTI' and reimbursed_at is null;
