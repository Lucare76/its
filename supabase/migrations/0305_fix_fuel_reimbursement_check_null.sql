-- Correzione della 0302: in SQL "invoice_supplier = 'CONTANTI'" con
-- invoice_supplier NULL vale NULL, e un CHECK che vale NULL passa. Così un
-- rifornimento poteva risultare rimborsato senza modo di pagamento.
-- Le API lo impedivano già; ora lo impedisce anche il database.
alter table public.vehicle_fuel
  drop constraint if exists vehicle_fuel_reimbursement_check,
  add constraint vehicle_fuel_reimbursement_check check (
    (reimbursed_at is null or (invoice_supplier is not null and invoice_supplier = 'CONTANTI'))
    and (reimbursed_by is null or reimbursed_at is not null)
    and (reimbursement_note is null or char_length(reimbursement_note) <= 500)
  );
