-- Conserva il prezzo pagato dal conducente e quattro decimali nel netto UTA.
alter table public.vehicle_fuel
  alter column cost type numeric(12,4),
  add column if not exists gross_cost numeric(10,2) null;

-- Una sola registrazione storica UTA/QR è presente al momento della migrazione.
-- Le registrazioni senza fornitore non vengono trasformate per evitare
-- di attribuire loro una fattura errata.
update public.vehicle_fuel
set gross_cost = cost,
    cost = round(cost / 1.22, 4)
where submitted_via_qr = true
  and invoice_supplier = 'UTA'
  and cost is not null
  and gross_cost is null;
